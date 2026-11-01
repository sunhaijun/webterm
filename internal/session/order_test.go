package session_test

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// IT-order-1：会话的显示顺序是 agent 上的状态（ADR-0040，AC-4.13）。
// 这里测会话管理器那一半；连接层那一半（session.move → 广播 session.order、
// req_id 只在发起方、welcome.sessions[] 按顺序）在 internal/agent 的
// TestITOrder1_MoveBroadcastsOrder。

func sidPtr(v uint16) *uint16 { return &v }

// wantOrder 检查 Order / List / Infos 三处给出的是同一个顺序。
func wantOrder(t *testing.T, m *session.Manager, want ...uint16) {
	t.Helper()
	if got := m.Order(); !slices.Equal(got, want) {
		t.Fatalf("Order() = %v, want %v", got, want)
	}
	var list, infos []uint16
	for _, s := range m.List() {
		list = append(list, s.SID())
	}
	for _, in := range m.Infos() {
		infos = append(infos, in.SID)
	}
	if !slices.Equal(list, want) || !slices.Equal(infos, want) {
		t.Fatalf("List() = %v, Infos() = %v, want %v", list, infos, want)
	}
}

// 新建排最后、关闭去掉 —— 排在【当前顺序】的最后，而不是按 sid 插回去。
func TestITOrder1_CreateAppendsCloseRemoves(t *testing.T) {
	m := newManager(t, cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()
	wantOrder(t, m, a, b, c)

	if err := m.Move(c, sidPtr(a), nil); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a, b)

	if _, err := m.Close(a); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, b)

	d := create(t, m).SID()
	wantOrder(t, m, c, b, d)
}

// session.move 的各种 before；成功就带着完整顺序调 publish，位置没变也调。
func TestITOrder1_Move(t *testing.T) {
	m := newManager(t, cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()

	var published [][]uint16
	pub := func(o []uint16) { published = append(published, o) }

	steps := []struct {
		name   string
		sid    uint16
		before *uint16
		want   []uint16
	}{
		{"挪到某个会话前面", c, sidPtr(a), []uint16{c, a, b}},
		{"before 为 null：放最后", c, nil, []uint16{a, b, c}},
		{"挪到第一个前面", c, sidPtr(a), []uint16{c, a, b}},
		{"挪到紧跟着的那个前面：位置不变", a, sidPtr(b), []uint16{c, a, b}},
		{"before 等于 sid：原地不动", a, sidPtr(a), []uint16{c, a, b}},
		{"已经在最后再放最后：位置不变", b, nil, []uint16{c, a, b}},
		{"before 不存在：当最后", c, sidPtr(999), []uint16{a, b, c}},
	}
	for _, st := range steps {
		n := len(published)
		if err := m.Move(st.sid, st.before, pub); err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		wantOrder(t, m, st.want...)
		if len(published) != n+1 || !slices.Equal(published[n], st.want) {
			t.Fatalf("%s: 广播 %v, want 一次 %v", st.name, published[n:], st.want)
		}
	}

	// sid 不存在：ErrUnknownSession，不广播，顺序不动
	n := len(published)
	if err := m.Move(999, nil, pub); err != session.ErrUnknownSession {
		t.Fatalf("sid 不存在: err = %v, want ErrUnknownSession", err)
	}
	// 刚关掉的会话同样不存在；拿它当 before 就是放最后
	if _, err := m.Close(b); err != nil {
		t.Fatal(err)
	}
	if err := m.Move(b, sidPtr(a), pub); err != session.ErrUnknownSession {
		t.Fatalf("已关闭的 sid: err = %v, want ErrUnknownSession", err)
	}
	if len(published) != n {
		t.Fatalf("失败的 move 也广播了: %v", published[n:])
	}
	wantOrder(t, m, a, c)
	if err := m.Move(a, sidPtr(b), pub); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a)
}

// 并发 move：广播与改动在同一把锁里，所以最后一次广播出去的顺序就是 agent 上的
// 顺序 —— 两台设备同时拖，两边最终一致（ADR-0040 §2）。
func TestITOrder1_ConcurrentMovesLastPublishWins(t *testing.T) {
	m := newManager(t, cfg())
	all := []uint16{create(t, m).SID(), create(t, m).SID(), create(t, m).SID()}

	var mu sync.Mutex
	var last []uint16
	var bad []string
	pub := func(o []uint16) {
		mu.Lock()
		defer mu.Unlock()
		last = o
		if got := slices.Sorted(slices.Values(o)); !slices.Equal(got, slices.Sorted(slices.Values(all))) {
			bad = append(bad, "广播的顺序不是全部会话的一个排列")
		}
	}

	var wg sync.WaitGroup
	for g := range 4 {
		wg.Go(func() {
			for i := range 200 {
				sid := all[(g+i)%len(all)]
				var before *uint16
				if i%3 != 0 {
					before = sidPtr(all[(g+2*i)%len(all)])
				}
				if err := m.Move(sid, before, pub); err != nil {
					t.Error(err)
					return
				}
				_ = m.List()
			}
		})
	}
	wg.Wait()

	if len(bad) > 0 {
		t.Fatal(bad[0])
	}
	if got := m.Order(); !slices.Equal(got, last) {
		t.Fatalf("agent 上的顺序 %v ≠ 最后一次广播 %v", got, last)
	}
}

// 热升级后顺序不变：快照的 sessions[] 按显示顺序排，新进程按它恢复；next_sid
// 照旧，新建的接着排最后。
//
// 旧 Manager【不能 Shutdown】—— 那会杀掉 shell；交接之后它就是一具空壳。
func TestITOrder1_HandoffKeepsOrder(t *testing.T) {
	m := session.NewManager(cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()
	if err := m.Move(c, sidPtr(a), nil); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a, b)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Schema != 2 {
		t.Fatalf("schema = %d：顺序不该让快照格式升版本", snap.Schema)
	}
	var inSnap []uint16
	for _, hs := range snap.Sessions {
		inSnap = append(inSnap, hs.SID)
	}
	if want := []uint16{c, a, b}; !slices.Equal(inSnap, want) {
		t.Fatalf("快照里 sessions[] 的顺序 = %v, want %v", inSnap, want)
	}

	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m2, c, a, b)

	// next_sid 语义不变：新进程接着旧进程往下分，新建的排最后
	d := create(t, m2).SID()
	if d != snap.NextSID {
		t.Fatalf("交接后新建的 sid = %d, want next_sid %d", d, snap.NextSID)
	}
	wantOrder(t, m2, c, a, b, d)
}

// 显示顺序就是快照里 sessions[] 的顺序。老版本的快照是按 sid 排的，恢复出来就是
// 按 sid 的顺序。用已退出的会话拼快照：不需要 fd 与进程。
func TestITOrder1_RestoreFollowsSnapshotSliceOrder(t *testing.T) {
	exited := func(sid uint16) handoff.Session {
		return handoff.Session{
			SID: sid, PtmxFD: -1, CreatedAt: time.Now(),
			CWD: "/", Status: protocol.StatusExited, Cols: 80, Rows: 24,
		}
	}
	for _, tc := range []struct {
		name string
		sids []uint16
	}{
		{"新快照：按显示顺序", []uint16{5, 2, 7}},
		{"老快照：按 sid", []uint16{2, 5, 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snap := &handoff.Snapshot{Schema: handoff.Schema, InstanceID: "x", NextSID: 8}
			for _, sid := range tc.sids {
				snap.Sessions = append(snap.Sessions, exited(sid))
			}
			m := newManager(t, cfg())
			if err := m.Restore(snap); err != nil {
				t.Fatal(err)
			}
			wantOrder(t, m, tc.sids...)
		})
	}
}
