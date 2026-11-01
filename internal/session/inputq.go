package session

import (
	"errors"
	"sync"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// maxInputQueueBytes caps each session's input queue (protocol §5.5).
//
// Hitting it means the foreground program hasn't read stdin in a long time.
// The connection is closed instead of blocking: one WebSocket carries every
// session, so a blocked enqueue would stall the connection's read loop and
// with it ping/pong, resize, and input to every other session.
const maxInputQueueBytes = 256 << 10

// ErrInputStalled means the input queue is full. The caller should reply with
// input_stalled and close the connection.
var ErrInputStalled = errors.New("session: input queue is full")

type inputItem struct {
	clientID string
	data     []byte
}

// inputQueue is a byte-counted FIFO that can drop one client's items.
//
// It is a custom queue rather than a channel because on disconnect the
// client's queued-but-unwritten bytes must be dropped: they were never acked,
// the client still holds them as pending and resends them after reconnecting,
// and keeping them would write them twice.
type inputQueue struct {
	mu     sync.Mutex
	items  []inputItem
	bytes  int
	closed bool
	notify chan struct{} // cap 1, edge-triggered
}

func newInputQueue() *inputQueue {
	return &inputQueue{notify: make(chan struct{}, 1)}
}

// push enqueues without blocking. It returns ErrInputStalled when the queue is
// full and nil (silently dropping data) when it is closed.
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

// pop removes the head item. It returns ok=false when empty.
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

// dropClient discards a client's input not yet written to the PTY and returns
// the number of bytes dropped. Called on disconnect: those bytes were never
// acked and the client resends them after reconnecting.
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

// pushFront puts a partially written item back at the head, used when a
// deadline interrupts a write (ADR-0016). It ignores the byte limit since the
// data was already in the queue.
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

// snapshot returns all input not yet written to the PTY, for hot-upgrade
// handoff.
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

// restore requeues handed-over input in the new process. Accounting
// (inQueued) is restored with the session, so it is not counted again here.
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
