package transcript

import (
	"bytes"
	"io"
	"os"
	"sync"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// 会话文件里最多保留多少条给 GET /api/transcript 回放；再多也没人往上翻。
const maxItems = 5000

// Service 按会话跟踪前台 AI CLI 的会话文件（ADR-0012 β）。
//
// 命令开始时认出 claude / codex 就起一个 tracker：先定位命令开始之后被写过的文件
// （轮询，文件可能几百毫秒后才出现），然后每个 tick 读增量、解析、推 transcript 消息。
// 命令结束（或 shell 退出）停止跟踪，条目留给回放，直到下一次 AI 命令开始或会话关闭。
type Service struct {
	roots Roots
	emit  func(msg any)
	poll  time.Duration
	now   func() time.Time

	mu       sync.Mutex
	trackers map[uint16]*tracker
}

// Snapshot 是某会话当前的转录（HTTP 回放用）。
type Snapshot struct {
	SID    uint16                    `json:"sid"`
	Source string                    `json:"source"`
	Active bool                      `json:"active"`
	Items  []protocol.TranscriptItem `json:"items"`
}

type tracker struct {
	sid    uint16
	source string
	cwd    string
	since  time.Time

	mu     sync.Mutex
	file   string
	offset int64
	rest   []byte
	seq    int
	items  []protocol.TranscriptItem
	active bool

	stop chan struct{}
	done chan struct{}
}

// New 建服务。emit 把 *protocol.Transcript 发给所有连接（session.Manager.Fanout）。
func New(roots Roots, emit func(msg any)) *Service {
	return &Service{roots: roots, emit: emit, poll: 400 * time.Millisecond, now: time.Now, trackers: make(map[uint16]*tracker)}
}

// CommandStarted 实现 session.CommandObserver：前台起了 claude / codex 就开始跟踪。
func (s *Service) CommandStarted(sid uint16, text, cwd string) {
	src := SourceFor(ProgramOf(text))
	if src == "" {
		return
	}
	// 定位窗口往前放两秒：文件的 mtime 与我们收到 133;C 的时间不必严格有序
	t := &tracker{sid: sid, source: src, cwd: cwd, since: s.now().Add(-2 * time.Second), active: true,
		stop: make(chan struct{}), done: make(chan struct{})}
	s.mu.Lock()
	old := s.trackers[sid]
	s.trackers[sid] = t
	s.mu.Unlock()
	if old != nil {
		old.halt()
	}
	// 新一轮：让客户端先清空
	s.emit(&protocol.Transcript{SID: sid, Source: src, Items: []protocol.TranscriptItem{}, Reset: true})
	go s.run(t)
}

// CommandEnded 实现 session.CommandObserver：停止跟踪，条目留给回放。
func (s *Service) CommandEnded(sid uint16) {
	s.mu.Lock()
	t := s.trackers[sid]
	s.mu.Unlock()
	if t != nil {
		t.halt()
	}
}

// SessionClosed 实现 session.CommandObserver。
func (s *Service) SessionClosed(sid uint16) {
	s.mu.Lock()
	t := s.trackers[sid]
	delete(s.trackers, sid)
	s.mu.Unlock()
	if t != nil {
		t.halt()
	}
}

// Snapshot 返回某会话的转录；没跟踪过 → false。
func (s *Service) Snapshot(sid uint16) (Snapshot, bool) {
	s.mu.Lock()
	t := s.trackers[sid]
	s.mu.Unlock()
	if t == nil {
		return Snapshot{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	items := make([]protocol.TranscriptItem, len(t.items))
	copy(items, t.items)
	return Snapshot{SID: sid, Source: t.source, Active: t.active, Items: items}, true
}

// Close 停掉所有跟踪（进程退出前）。
func (s *Service) Close() {
	s.mu.Lock()
	ts := make([]*tracker, 0, len(s.trackers))
	for _, t := range s.trackers {
		ts = append(ts, t)
	}
	s.trackers = make(map[uint16]*tracker)
	s.mu.Unlock()
	for _, t := range ts {
		t.halt()
	}
}

func (t *tracker) halt() {
	select {
	case <-t.stop:
	default:
		close(t.stop)
	}
	<-t.done
}

func (s *Service) run(t *tracker) {
	defer close(t.done)
	tick := time.NewTicker(s.poll)
	defer tick.Stop()
	for {
		s.step(t)
		select {
		case <-t.stop:
			s.step(t) // 收尾：把最后一批读完
			t.mu.Lock()
			t.active = false
			t.mu.Unlock()
			return
		case <-tick.C:
		}
	}
}

// step 是一个 tick 的工作：还没定位到文件就找；找到了就读增量并推送。
func (s *Service) step(t *tracker) {
	if t.file == "" {
		switch t.source {
		case "claude":
			t.file = locateClaude(s.roots.Claude, t.cwd, t.since)
		case "codex":
			t.file = locateCodex(s.roots.Codex, t.cwd, t.since)
		}
		if t.file == "" {
			return
		}
	}
	f, err := os.Open(t.file)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return
	}
	data, err := io.ReadAll(f)
	if err != nil || len(data) == 0 {
		return
	}
	t.offset += int64(len(data))
	buf := append(t.rest, data...)
	var batch []protocol.TranscriptItem
	for {
		i := bytes.IndexByte(buf, '\n')
		if i < 0 {
			break
		}
		line := buf[:i]
		buf = buf[i+1:]
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		t.seq++
		var items []protocol.TranscriptItem
		switch t.source {
		case "claude":
			items = parseClaude(line, t.seq)
		case "codex":
			items = parseCodex(line, t.seq)
		}
		batch = append(batch, items...)
	}
	t.rest = append([]byte(nil), buf...)
	if len(batch) == 0 {
		return
	}
	t.mu.Lock()
	t.items = append(t.items, batch...)
	if n := len(t.items); n > maxItems {
		t.items = append([]protocol.TranscriptItem(nil), t.items[n-maxItems:]...)
	}
	t.mu.Unlock()
	s.emit(&protocol.Transcript{SID: t.sid, Source: t.source, Items: batch})
}
