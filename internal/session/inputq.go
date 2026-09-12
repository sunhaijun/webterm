package session

import (
	"errors"
	"sync"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// maxInputQueueBytes 是每会话输入队列的上限（协议 §5.5）。
//
// 触到它意味着前台程序已经很久不读 stdin 了。此时【关闭那条连接】而不是
// 阻塞：一条 WebSocket 复用所有会话，阻塞入队会把整条连接的读循环卡死 ——
// ping/pong、resize、其它会话的输入全停。
const maxInputQueueBytes = 256 << 10

// ErrInputStalled 表示输入队列已满，调用方应当回 input_stalled 并关闭连接。
var ErrInputStalled = errors.New("session: 输入队列已满")

type inputItem struct {
	clientID string
	data     []byte
}

// inputQueue 是一个按字节计量的 FIFO，支持按 client 丢弃。
//
// 用自己的队列而不是 channel，是因为断连时必须能把【那个 client 已入队但
// 还没写进 PTY】的字节丢掉：它们从未被 ack，客户端仍持在 pending 里，
// 重连后会重发。不丢的话就会重复写入。
type inputQueue struct {
	mu     sync.Mutex
	items  []inputItem
	bytes  int
	closed bool
	notify chan struct{} // cap 1，边沿通知
}

func newInputQueue() *inputQueue {
	return &inputQueue{notify: make(chan struct{}, 1)}
}

// push 非阻塞入队。队列满返回 ErrInputStalled，已关闭返回 nil（静默丢弃）。
func (q *inputQueue) push(clientID string, data []byte) error {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return nil
	}
	if q.bytes+len(data) > maxInputQueueBytes {
		q.mu.Unlock()
		return ErrInputStalled
	}
	q.items = append(q.items, inputItem{clientID: clientID, data: data})
	q.bytes += len(data)
	q.mu.Unlock()

	select {
	case q.notify <- struct{}{}:
	default:
	}
	return nil
}

// pop 取出队首。空则返回 ok=false。
func (q *inputQueue) pop() (inputItem, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return inputItem{}, false
	}
	it := q.items[0]
	q.items[0] = inputItem{}
	q.items = q.items[1:]
	q.bytes -= len(it.data)
	return it, true
}

// dropClient 丢弃某个 client 尚未写入 PTY 的输入，返回丢弃的字节数。
// 断连时调用 —— 这些字节从未被 ack，重连后客户端会重发。
func (q *inputQueue) dropClient(clientID string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	kept := q.items[:0]
	dropped := 0
	for _, it := range q.items {
		if it.clientID == clientID {
			dropped += len(it.data)
			continue
		}
		kept = append(kept, it)
	}
	q.items = kept
	q.bytes -= dropped
	return dropped
}

func (q *inputQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.items = nil
	q.bytes = 0
	q.mu.Unlock()
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// pushFront 把一段没写完的输入放回队首（写被 deadline 打断时用，ADR-0016）。
// 不受字节上限约束 —— 它本来就在队里。
func (q *inputQueue) pushFront(it inputItem) {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.items = append([]inputItem{it}, q.items...)
	q.bytes += len(it.data)
	q.mu.Unlock()
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// snapshot 导出还没写进 PTY 的全部输入（热升级交接）。
func (q *inputQueue) snapshot() []handoff.PendingInput {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return nil
	}
	out := make([]handoff.PendingInput, 0, len(q.items))
	for _, it := range q.items {
		out = append(out, handoff.PendingInput{ClientID: it.clientID, Data: append([]byte(nil), it.data...)})
	}
	return out
}

// restore 在新进程里把交接过来的输入原样排回队列。记账（inQueued）随会话一起
// 恢复，这里不再计。
func (q *inputQueue) restore(items []handoff.PendingInput) {
	q.mu.Lock()
	for _, it := range items {
		q.items = append(q.items, inputItem{clientID: it.ClientID, data: append([]byte(nil), it.Data...)})
		q.bytes += len(it.Data)
	}
	q.mu.Unlock()
	if len(items) > 0 {
		select {
		case q.notify <- struct{}{}:
		default:
		}
	}
}
