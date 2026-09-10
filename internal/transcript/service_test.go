package transcript

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

type sink struct {
	mu   sync.Mutex
	msgs []*protocol.Transcript
}

func (k *sink) emit(m any) {
	if t, ok := m.(*protocol.Transcript); ok {
		k.mu.Lock()
		k.msgs = append(k.msgs, t)
		k.mu.Unlock()
	}
}

func (k *sink) wait(t *testing.T, pred func([]*protocol.Transcript) bool, what string) []*protocol.Transcript {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		k.mu.Lock()
		cp := append([]*protocol.Transcript(nil), k.msgs...)
		k.mu.Unlock()
		if pred(cp) {
			return cp
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("超时等待：%s", what)
	return nil
}

func appendLine(t *testing.T, p, line string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

// IT-transcript-1：claude 起来 → 先发 reset；文件晚一点才出现也能跟上；增量按行推；
// 半行不推；命令结束停止跟踪、快照仍可回放；再起一次 → 又一个 reset 且旧条目清掉。
func TestServiceClaude(t *testing.T) {
	home := t.TempDir()
	roots := DefaultRoots(home)
	k := &sink{}
	s := New(roots, k.emit)
	s.poll = 20 * time.Millisecond
	defer s.Close()

	s.CommandStarted(7, "claude --model sonnet", "/home/sun")
	k.wait(t, func(m []*protocol.Transcript) bool {
		return len(m) == 1 && m[0].Reset && m[0].Source == "claude" && m[0].SID == 7
	}, "先发 reset")

	// 非 AI 程序不跟踪
	s.CommandStarted(8, "ls -la", "/home/sun")
	if _, ok := s.Snapshot(8); ok {
		t.Fatal("ls 不该有转录")
	}

	file := filepath.Join(roots.Claude, "-home-sun", "sess-1.jsonl")
	time.Sleep(60 * time.Millisecond) // 文件晚于命令出现
	appendLine(t, file, `{"type":"user","uuid":"u1","timestamp":"2026-09-09T06:31:00.000Z","message":{"role":"user","content":"你好"}}`)
	got := k.wait(t, func(m []*protocol.Transcript) bool { return len(m) == 2 }, "第一条用户消息")
	if got[1].Reset || len(got[1].Items) != 1 || got[1].Items[0].Text != "你好" {
		t.Fatalf("增量 = %+v", got[1])
	}

	// 半行不推，补齐换行才推
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(`{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"你好！`)
	f.Close()
	time.Sleep(80 * time.Millisecond)
	k.mu.Lock()
	n := len(k.msgs)
	k.mu.Unlock()
	if n != 2 {
		t.Fatalf("半行不该推送，消息数 = %d", n)
	}
	appendLine(t, file, `"}]}}`)
	got = k.wait(t, func(m []*protocol.Transcript) bool { return len(m) == 3 }, "补齐后推送")
	if got[2].Items[0].Role != "assistant" || got[2].Items[0].Text != "你好！" {
		t.Fatalf("assistant = %+v", got[2].Items)
	}

	s.CommandEnded(7)
	snap, ok := s.Snapshot(7)
	if !ok || snap.Active || len(snap.Items) != 2 || snap.Source != "claude" {
		t.Fatalf("结束后快照 = %+v ok=%v", snap, ok)
	}
	// 结束后再写文件不再推
	appendLine(t, file, `{"type":"user","uuid":"u9","message":{"role":"user","content":"晚到"}}`)
	time.Sleep(80 * time.Millisecond)
	k.mu.Lock()
	n = len(k.msgs)
	k.mu.Unlock()
	if n != 3 {
		t.Fatalf("结束后不该再推送，消息数 = %d", n)
	}

	// 再起一次：reset，旧条目清掉
	s.CommandStarted(7, "claude", "/home/sun")
	got = k.wait(t, func(m []*protocol.Transcript) bool { return len(m) == 4 && m[3].Reset }, "第二轮 reset")
	snap, _ = s.Snapshot(7)
	if len(snap.Items) != 0 || !snap.Active {
		t.Fatalf("第二轮快照应为空且 active：%+v", snap)
	}
	s.SessionClosed(7)
	if _, ok := s.Snapshot(7); ok {
		t.Fatal("会话关闭后没有快照")
	}
}

// IT-transcript-2：codex 走 rollout 文件，cwd 从 session_meta 核对。
func TestServiceCodex(t *testing.T) {
	home := t.TempDir()
	roots := DefaultRoots(home)
	k := &sink{}
	s := New(roots, k.emit)
	s.poll = 20 * time.Millisecond
	defer s.Close()

	other := filepath.Join(roots.Codex, "2026", "09", "09", "rollout-other.jsonl")
	appendLine(t, other, `{"type":"session_meta","payload":{"cwd":"/elsewhere"}}`)
	s.CommandStarted(3, "codex", "/home/sun")
	mine := filepath.Join(roots.Codex, "2026", "09", "09", "rollout-mine.jsonl")
	appendLine(t, mine, `{"type":"session_meta","payload":{"cwd":"/home/sun"}}`)
	appendLine(t, mine, `{"timestamp":"2026-09-09T13:26:30.000Z","type":"response_item","payload":{"type":"message","id":"m3","role":"assistant","content":[{"type":"output_text","text":"好的。"}]}}`)
	got := k.wait(t, func(m []*protocol.Transcript) bool { return len(m) >= 2 }, "codex 增量")
	if got[1].Source != "codex" || len(got[1].Items) != 1 || got[1].Items[0].Text != "好的。" {
		t.Fatalf("codex 增量 = %+v", got[1])
	}
	// 别处那个文件后来也在写，不该串进来
	appendLine(t, other, `{"timestamp":"2026-09-09T13:26:31.000Z","type":"response_item","payload":{"type":"message","id":"m9","role":"assistant","content":[{"type":"output_text","text":"串台"}]}}`)
	time.Sleep(80 * time.Millisecond)
	snap, _ := s.Snapshot(3)
	for _, it := range snap.Items {
		if it.Text == "串台" {
			t.Fatal("别的 cwd 的会话串进来了")
		}
	}
}
