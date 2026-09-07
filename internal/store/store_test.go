package store_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

func open(t *testing.T) (*store.Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func at(ms int64) time.Time { return time.UnixMilli(ms) }

// seed 灌入若干条命令，返回它们的 id（按传入顺序）。
func seed(t *testing.T, s *store.Store, specs ...struct {
	text, cwd string
	startedAt int64
	exitCode  int
},
) []int64 {
	t.Helper()
	var ids []int64
	for _, sp := range specs {
		id, err := s.BeginCommand(sp.text, "sess", sp.cwd, at(sp.startedAt))
		if err != nil {
			t.Fatal(err)
		}
		code := sp.exitCode
		if err := s.FinishCommand(id, &code, 100*time.Millisecond); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

type spec = struct {
	text, cwd string
	startedAt int64
	exitCode  int
}

// UT-store-1：历史查询的过滤与游标分页。
func TestStore1_ListFilterAndCursor(t *testing.T) {
	s, _ := open(t)
	seed(t, s,
		spec{"go build ./...", "/srv/a", 1000, 0},
		spec{"go test ./...", "/srv/a", 2000, 1},
		spec{"docker ps", "/srv/b", 3000, 0},
		spec{"go vet ./...", "/srv/b", 4000, 0},
	)

	t.Run("按原文子串过滤", func(t *testing.T) {
		got, err := s.ListCommands(store.Filter{Q: "go "})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 3 {
			t.Fatalf("命中 %d 条, want 3", len(got))
		}
		if got[0].Text != "go vet ./..." { // 时间倒序
			t.Fatalf("首条 = %q, want 最新的那条", got[0].Text)
		}
	})

	t.Run("按 CWD 过滤", func(t *testing.T) {
		got, _ := s.ListCommands(store.Filter{CWD: "/srv/b"})
		if len(got) != 2 {
			t.Fatalf("命中 %d 条, want 2", len(got))
		}
	})

	t.Run("只看失败的", func(t *testing.T) {
		got, _ := s.ListCommands(store.Filter{FailedOnly: true})
		if len(got) != 1 || got[0].Text != "go test ./..." {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("未完成的命令不算失败", func(t *testing.T) {
		if _, err := s.BeginCommand("sleep 999", "sess", "/srv/a", at(5000)); err != nil {
			t.Fatal(err)
		}
		got, _ := s.ListCommands(store.Filter{FailedOnly: true})
		if len(got) != 1 {
			t.Fatalf("命中 %d 条, want 1（exit_code IS NULL 不该被算成失败）", len(got))
		}
		// 但它应当出现在普通列表里，且 exit_code / duration_ms 为 NULL
		all, _ := s.ListCommands(store.Filter{Q: "sleep"})
		if len(all) != 1 || all[0].ExitCode != nil || all[0].DurationMS != nil {
			t.Fatalf("未完成的记录 = %+v", all)
		}
	})

	t.Run("游标分页不漏不重", func(t *testing.T) {
		var seen []string
		before := int64(0)
		for range 10 {
			page, err := s.ListCommands(store.Filter{Q: "go ", Limit: 2, Before: before})
			if err != nil {
				t.Fatal(err)
			}
			if len(page) == 0 {
				break
			}
			for _, c := range page {
				seen = append(seen, c.Text)
			}
			before = page[len(page)-1].StartedAt
		}
		if len(seen) != 3 {
			t.Fatalf("翻页共见到 %d 条 (%v), want 3", len(seen), seen)
		}
		uniq := map[string]bool{}
		for _, v := range seen {
			if uniq[v] {
				t.Fatalf("重复见到 %q", v)
			}
			uniq[v] = true
		}
	})
}

// UT-store-2：置顶与排序。
func TestStore2_PinAndOrder(t *testing.T) {
	s, _ := open(t)
	ids := seed(t, s,
		spec{"cmd-a", "/x", 1000, 0},
		spec{"cmd-b", "/x", 2000, 0},
		spec{"cmd-c", "/x", 3000, 0},
	)

	yes := true
	for _, id := range ids {
		if err := s.UpdateCommand(id, store.Patch{Pinned: &yes}); err != nil {
			t.Fatal(err)
		}
	}
	pinned, err := s.ListCommands(store.Filter{PinnedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(pinned) != 3 {
		t.Fatalf("置顶 %d 条, want 3", len(pinned))
	}
	// 置顶时未指定 pin_order → 依次追加，顺序稳定
	for i, c := range pinned {
		if c.PinOrder == nil || *c.PinOrder != int64(i+1) {
			t.Fatalf("第 %d 条 pin_order = %v, want %d", i, c.PinOrder, i+1)
		}
	}

	t.Run("批量重排", func(t *testing.T) {
		if err := s.Reorder(map[int64]int64{ids[0]: 3, ids[1]: 2, ids[2]: 1}); err != nil {
			t.Fatal(err)
		}
		got, _ := s.ListCommands(store.Filter{PinnedOnly: true})
		want := []string{"cmd-c", "cmd-b", "cmd-a"}
		for i := range want {
			if got[i].Text != want[i] {
				t.Fatalf("重排后 = %q, want %q", got[i].Text, want[i])
			}
		}
	})

	t.Run("设置 label", func(t *testing.T) {
		label := "重启服务"
		if err := s.UpdateCommand(ids[0], store.Patch{Label: &label}); err != nil {
			t.Fatal(err)
		}
		got, _ := s.ListCommands(store.Filter{Q: "cmd-a"})
		if got[0].Label == nil || *got[0].Label != label {
			t.Fatalf("label = %v", got[0].Label)
		}
	})

	t.Run("取消置顶必须清空 pin_order", func(t *testing.T) {
		no := false
		if err := s.UpdateCommand(ids[0], store.Patch{Pinned: &no}); err != nil {
			t.Fatal(err)
		}
		got, _ := s.ListCommands(store.Filter{Q: "cmd-a"})
		if got[0].Pinned {
			t.Fatal("仍是置顶")
		}
		if got[0].PinOrder != nil {
			t.Fatalf("pin_order = %v, want nil（残留会污染置顶列表排序）", *got[0].PinOrder)
		}
	})
}

// UT-store-3：删除单条与清空历史。
func TestStore3_DeleteAndClear(t *testing.T) {
	s, _ := open(t)
	ids := seed(t, s,
		spec{"keep-me", "/x", 1000, 0},
		spec{"delete-me", "/x", 2000, 0},
		spec{"clear-me", "/x", 3000, 0},
	)
	if err := s.DeleteCommand(ids[1]); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ListCommands(store.Filter{}); len(got) != 2 {
		t.Fatalf("删除后剩 %d 条, want 2", len(got))
	}

	yes := true
	if err := s.UpdateCommand(ids[0], store.Patch{Pinned: &yes}); err != nil {
		t.Fatal(err)
	}
	deleted, kept, err := s.ClearHistory()
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 || kept != 1 {
		t.Fatalf("清空: deleted=%d kept=%d, want 1/1", deleted, kept)
	}
	got, _ := s.ListCommands(store.Filter{})
	if len(got) != 1 || got[0].Text != "keep-me" {
		t.Fatalf("清空后 = %+v, want 只剩置顶的 keep-me", got)
	}
}

// UT-store-4：淘汰保护置顶记录。
//
// 快捷命令的生命周期跟历史行绑定 —— 淘汰掉置顶记录就等于把用户的快捷命令
// 删了（ADR-0008 / AC-6.10）。
func TestStore4_EvictProtectsPinned(t *testing.T) {
	s, _ := open(t)
	yes := true
	for i := range 50 {
		id, err := s.BeginCommand("cmd", "sess", "/x", at(int64(1000+i)))
		if err != nil {
			t.Fatal(err)
		}
		if i < 5 { // 最旧的 5 条置顶
			if err := s.UpdateCommand(id, store.Patch{Pinned: &yes}); err != nil {
				t.Fatal(err)
			}
		}
	}
	n, err := s.Evict(10)
	if err != nil {
		t.Fatal(err)
	}
	if n != 35 { // 45 条非置顶，留 10 条
		t.Fatalf("淘汰了 %d 条, want 35", n)
	}
	pinned, _ := s.ListCommands(store.Filter{PinnedOnly: true})
	if len(pinned) != 5 {
		t.Fatalf("置顶剩 %d 条, want 5（置顶永不淘汰）", len(pinned))
	}
	rest, _ := s.ListCommands(store.Filter{Limit: 200})
	if len(rest) != 15 { // 10 非置顶 + 5 置顶
		t.Fatalf("总共剩 %d 条, want 15", len(rest))
	}
}

// 迁移必须幂等：连续跑两次结果一致。
func TestMigrationsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s1, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	v1, _ := s1.SchemaVersion()
	if _, err := s1.BeginCommand("marker", "s", "/x", time.Now()); err != nil {
		t.Fatal(err)
	}
	s1.Close()

	s2, err := store.Open(dir)
	if err != nil {
		t.Fatalf("第二次 Open 失败: %v", err)
	}
	defer s2.Close()
	v2, _ := s2.SchemaVersion()
	if v1 != v2 || v1 == 0 {
		t.Fatalf("schema 版本 %d → %d", v1, v2)
	}
	got, _ := s2.ListCommands(store.Filter{})
	if len(got) != 1 || got[0].Text != "marker" {
		t.Fatal("重开后数据丢了")
	}
}

// IT-store-1：DB 文件权限必须是 0600（AC-1.12）。
// SQLite 自己创建时受 umask 影响，可能得到 0644。
func TestStoreFilePermissions(t *testing.T) {
	_, dir := open(t)
	fi, err := os.Stat(filepath.Join(dir, "webterm.db"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("webterm.db 权限 = %04o, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("数据目录权限 = %04o, want 0700", perm)
	}
}

// Composer 的历史导航：前缀匹配且去重。
func TestPrefixHistoryDeduplicates(t *testing.T) {
	s, _ := open(t)
	seed(t, s,
		spec{"go test ./...", "/x", 1000, 0},
		spec{"go test ./...", "/x", 2000, 0},
		spec{"go test ./...", "/x", 3000, 0},
		spec{"go build", "/x", 4000, 0},
		spec{"ls", "/x", 5000, 0},
	)
	got, err := s.PrefixHistory("go ", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("前缀命中 %d 条 (%v), want 2（重复的必须去重，否则连按 ↑ 会原地打转）", len(got), got)
	}
	if got[0] != "go build" {
		t.Fatalf("首条 = %q, want 最近执行的 go build", got[0])
	}
}

// Composer 的历史导航：前缀匹配 + 去重（http-api.md 的 prefix 模式）。
func TestListByPrefixDeduplicates(t *testing.T) {
	s, _ := open(t)
	seed(t, s,
		spec{"go test ./...", "/x", 1000, 0},
		spec{"go test ./...", "/x", 2000, 0},
		spec{"go test -run X", "/x", 3000, 0},
		spec{"go build", "/x", 4000, 0},
		spec{"ls -la", "/x", 5000, 0},
	)
	got, err := s.ListCommands(store.Filter{Prefix: "go "})
	if err != nil {
		t.Fatal(err)
	}
	texts := make([]string, len(got))
	for i, c := range got {
		texts[i] = c.Text
	}
	// 三条不同的 go 命令，重复的那条只出现一次；按最近执行时间倒序
	want := []string{"go build", "go test -run X", "go test ./..."}
	if len(texts) != len(want) {
		t.Fatalf("命中 %d 条 (%v), want %d 条 —— 不去重的话连按 ↑ 会原地打转", len(texts), texts, len(want))
	}
	for i := range want {
		if texts[i] != want[i] {
			t.Fatalf("第 %d 条 = %q, want %q（顺序应当按最近执行时间倒序）", i, texts[i], want[i])
		}
	}
}
