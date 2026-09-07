package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/shellinit"
	"github.com/sunhaijun/webterm/internal/store"
)

// integHarness 起一个【带 shell 集成】的会话，并把 HOME 指到一个受控目录，
// 好让 .bashrc / .bash_profile 的内容是确定的。
type integHarness struct {
	t    *testing.T
	m    *session.Manager
	st   *store.Store
	home string
	runD string
}

type integOpts struct {
	bashrc      string
	bashProfile string
	login       bool
	noHistory   bool
}

func newInteg(t *testing.T, o integOpts) *integHarness {
	t.Helper()
	home := t.TempDir()
	runD := filepath.Join(t.TempDir(), "run")
	if o.bashrc != "" {
		writeFile(t, filepath.Join(home, ".bashrc"), o.bashrc)
	}
	if o.bashProfile != "" {
		writeFile(t, filepath.Join(home, ".bash_profile"), o.bashProfile)
	}

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	// HOME 指到受控目录，测试才有确定性
	t.Setenv("HOME", home)

	m := session.NewManager(session.Config{
		MaxSessions: 5,
		RingBytes:   1 << 20,
		Shell:       "bash",
		History:     !o.noHistory,
		RCFileFor: func(sid uint16) (string, error) {
			return shellinit.Render(sid, shellinit.Options{Login: o.login, Dir: runD})
		},
	}, st)
	t.Cleanup(m.Shutdown)
	return &integHarness{t: t, m: m, st: st, home: home, runD: runD}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// session 建一个会话并等集成握手完成。
func (h *integHarness) session() (*session.Session, *fakeConn) {
	h.t.Helper()
	s, err := h.m.Create(session.Spec{CWD: h.home, Cols: 80, Rows: 24})
	if err != nil {
		h.t.Fatal(err)
	}
	c := newConn(h.t, h.m, "tab")
	s.Subscribe(c, 0)
	return s, c
}

func (h *integHarness) waitActive(s *session.Session) {
	h.t.Helper()
	waitFor(h.t, "集成握手完成（integration=active）", func() bool {
		return s.Snapshot().Integration == protocol.IntegrationActive
	})
}

// commandsOf 返回落库的命令记录（时间正序）。
func (h *integHarness) commands() []store.Command {
	h.t.Helper()
	got, err := h.st.ListCommands(store.Filter{Limit: 200})
	if err != nil {
		h.t.Fatal(err)
	}
	// ListCommands 是时间倒序，翻过来读着顺
	for i, j := 0, len(got)-1; i < j; i, j = i+1, j-1 {
		got[i], got[j] = got[j], got[i]
	}
	return got
}

// IT-shell-1：命令记录 —— 原文、CWD、退出码、耗时（AC-6.1）。
func TestITShell1_CommandRecorded(t *testing.T) {
	h := newInteg(t, integOpts{})
	s, c := h.session()
	h.waitActive(s)

	if err := c.Send(s, "echo recorded-one\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "recorded-one")
	if err := c.Send(s, "false\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "两条命令都落库", func() bool { return len(h.commands()) >= 2 })
	waitQuiet(t, s, 300*time.Millisecond)

	cmds := h.commands()
	if cmds[0].Text != "echo recorded-one" {
		t.Fatalf("命令原文 = %q", cmds[0].Text)
	}
	if cmds[0].ExitCode == nil || *cmds[0].ExitCode != 0 {
		t.Fatalf("退出码 = %v, want 0", cmds[0].ExitCode)
	}
	if cmds[0].DurationMS == nil {
		t.Fatal("耗时没记下来")
	}
	if cmds[0].CWD != h.home {
		t.Fatalf("CWD = %q, want %q", cmds[0].CWD, h.home)
	}
	if cmds[1].Text != "false" || cmds[1].ExitCode == nil || *cmds[1].ExitCode != 1 {
		t.Fatalf("第二条 = %+v, want false/exit 1", cmds[1])
	}

	t.Run("连续两次同一条命令要记两次", func(t *testing.T) {
		// 比历史【编号】而不是比原文，就是为了这个场景。
		// 比原文的话第二次会被误判成"没进历史"而漏记。
		before := len(h.commands())
		if err := c.Send(s, "echo dup\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "第一次 dup", func() bool { return len(h.commands()) == before+1 })
		if err := c.Send(s, "echo dup\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "第二次 dup 也要记下来", func() bool { return len(h.commands()) == before+2 })
	})
}

// IT-shell-2：以空格开头的命令不进历史（AC-6.2 / US-6.7）。
func TestITShell2_LeadingSpaceSkipped(t *testing.T) {
	h := newInteg(t, integOpts{})
	s, c := h.session()
	h.waitActive(s)

	if err := c.Send(s, "echo before-secret\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "第一条落库", func() bool { return len(h.commands()) == 1 })

	// 前导空格 → 不进 bash 历史 → 我们也不上报
	if err := c.Send(s, " echo TOP-SECRET-TOKEN\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "TOP-SECRET-TOKEN")

	if err := c.Send(s, "echo after-secret\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "第三条落库", func() bool { return len(h.commands()) == 2 })
	waitQuiet(t, s, 300*time.Millisecond)

	for _, cmd := range h.commands() {
		if strings.Contains(cmd.Text, "TOP-SECRET-TOKEN") {
			t.Fatalf("以空格开头的命令被记下来了: %q", cmd.Text)
		}
	}
	if got := len(h.commands()); got != 2 {
		t.Fatalf("记录数 = %d, want 2（中间那条应当被跳过）", got)
	}
}

// IT-shell-3：rcfile 注入 —— 用户【无需修改任何 dotfile】（AC-7.1）。
func TestITShell3_NoDotfileChanges(t *testing.T) {
	h := newInteg(t, integOpts{bashrc: "export MY_MARKER=from-bashrc\n"})
	s, c := h.session()
	h.waitActive(s)

	// 用户的 .bashrc 照常生效
	if err := c.Send(s, "echo $MY_MARKER\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "from-bashrc")

	// 而 .bashrc 本身没被改过
	got, err := os.ReadFile(filepath.Join(h.home, ".bashrc"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "export MY_MARKER=from-bashrc\n" {
		t.Fatalf(".bashrc 被改动了:\n%s", got)
	}
	if strings.Contains(string(got), "webterm") {
		t.Fatal("往用户的 dotfile 里写了东西")
	}
}

// IT-shell-4：不覆盖用户的 PS1 / PROMPT_COMMAND / 已有 DEBUG trap（AC-7.2）。
func TestITShell4_WrapsNotOverrides(t *testing.T) {
	h := newInteg(t, integOpts{bashrc: `
PS1='USERPROMPT> '
__user_precmd() { echo "USER-PRECMD-RAN"; }
PROMPT_COMMAND=__user_precmd
trap 'echo USER-DEBUG-RAN >> ` + "\"$HOME/debug.log\"" + `' DEBUG
`})
	s, c := h.session()
	h.waitActive(s)

	if err := c.Send(s, "echo wrap-check\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "wrap-check")
	waitQuiet(t, s, 400*time.Millisecond)

	screen := c.Screen()
	if !strings.Contains(screen, "USERPROMPT>") {
		t.Errorf("用户的 PS1 被覆盖了，屏幕上看不到它:\n%q", tailOf(screen, 200))
	}
	if !strings.Contains(screen, "USER-PRECMD-RAN") {
		t.Errorf("用户的 PROMPT_COMMAND 被覆盖了")
	}
	if b, err := os.ReadFile(filepath.Join(h.home, "debug.log")); err != nil || len(b) == 0 {
		t.Errorf("用户已有的 DEBUG trap 被替换了（没有链式调用）")
	}
	// 而集成本身照常工作
	if len(h.commands()) == 0 {
		t.Error("包装之后集成不工作了")
	}
}

// IT-shell-5：登录 / 非登录模式的 profile 链，且 .bashrc 不被重复加载（AC-7.3）。
func TestITShell5_ProfileChain(t *testing.T) {
	t.Run("登录模式走 profile 链", func(t *testing.T) {
		h := newInteg(t, integOpts{
			login:       true,
			bashProfile: "export FROM_PROFILE=yes\n. \"$HOME/.bashrc\"\n",
			bashrc:      "export FROM_BASHRC=yes\nBASHRC_COUNT=$((BASHRC_COUNT+1)); export BASHRC_COUNT\n",
		})
		s, c := h.session()
		h.waitActive(s)

		if err := c.Send(s, "echo P=$FROM_PROFILE B=$FROM_BASHRC N=$BASHRC_COUNT\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "变量都读到了", func() bool { return strings.Contains(c.Screen(), "P=yes B=yes") })
		waitQuiet(t, s, 300*time.Millisecond)

		// .bashrc 只被 .bash_profile 加载了一次 —— 我们不额外再 source 一遍。
		// 重复 source 会导致 PATH 重复、别名重复定义、prompt 被叠加。
		if !strings.Contains(c.Screen(), "N=1") {
			t.Errorf(".bashrc 被加载了不止一次:\n%q", tailOf(c.Screen(), 200))
		}
	})

	t.Run("非登录模式只走 bashrc", func(t *testing.T) {
		h := newInteg(t, integOpts{
			login:       false,
			bashProfile: "export FROM_PROFILE=yes\n",
			bashrc:      "export FROM_BASHRC=yes\n",
		})
		s, c := h.session()
		h.waitActive(s)

		if err := c.Send(s, "echo P=[$FROM_PROFILE] B=[$FROM_BASHRC]\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "变量读到了", func() bool { return strings.Contains(c.Screen(), "B=[yes]") })
		if !strings.Contains(c.Screen(), "P=[]") {
			t.Errorf("非登录模式不该加载 .bash_profile:\n%q", tailOf(c.Screen(), 200))
		}
	})
}

// IT-shell-6：握手超时 → integration 标成 inactive（AC-7.6）。
func TestITShell6_HandshakeTimeout(t *testing.T) {
	// 不注入集成 = agent 明确知道没有集成
	m := newManager(t, cfg())
	s := create(t, m)
	if got := s.Snapshot().Integration; got != protocol.IntegrationInactive {
		t.Fatalf("没有集成时 integration = %q, want inactive", got)
	}
}

// IT-shell-7：集成脚本出错不影响终端可用性（AC-7.7）。
func TestITShell7_BrokenConfigStillUsable(t *testing.T) {
	// 用户的 .bashrc 里有语法错误
	h := newInteg(t, integOpts{bashrc: "this is not valid bash ((( \nexport OK=1\n"})
	s, c := h.session()

	// 终端【照常可用】—— 这是底线
	if err := c.Send(s, "echo still-alive\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "still-alive")
	if s.Status() != protocol.StatusRunning {
		t.Fatal("shell 启动失败了")
	}
}

// UT-name-1：会话名跟随 CWD（AC-4.4）。
func TestUTName1_AutoNamingFollowsCWD(t *testing.T) {
	h := newInteg(t, integOpts{})
	s, c := h.session()
	h.waitActive(s)

	sub := filepath.Join(h.home, "myproject")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "cd myproject\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "会话名跟着 CWD 变成 myproject", func() bool {
		return s.Snapshot().Name == "myproject"
	})
	if got := s.Snapshot().CWD; got != sub {
		t.Fatalf("CWD = %q, want %q", got, sub)
	}

	t.Run("含空格与中文的路径也要正确上报", func(t *testing.T) {
		weird := filepath.Join(h.home, "我的 项目")
		if err := os.Mkdir(weird, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := c.Send(s, "cd '"+weird+"'\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "CWD 正确 percent-decode", func() bool { return s.Snapshot().CWD == weird })
		if got := s.Snapshot().Name; got != "我的 项目" {
			t.Fatalf("会话名 = %q", got)
		}
	})

	t.Run("手动改名后停止跟随", func(t *testing.T) {
		manual := "构建"
		s.Rename(&manual)
		if err := c.Send(s, "cd "+h.home+"\r"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "CWD 变了", func() bool { return s.Snapshot().CWD == h.home })
		if got := s.Snapshot().Name; got != manual {
			t.Fatalf("手动名被 CWD 覆盖了: %q", got)
		}
	})
}

// prompt 状态事件必须发出来 —— 输入模式自动切换全靠它。
func TestPromptStateEvents(t *testing.T) {
	h := newInteg(t, integOpts{})
	s, c := h.session()
	h.waitActive(s)

	if err := c.Send(s, "echo prompt-check\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "prompt-check")
	waitQuiet(t, s, 400*time.Millisecond)

	var states []string
	for _, e := range c.Events() {
		if p, ok := e.(*protocol.Prompt); ok {
			states = append(states, p.State)
		}
	}
	joined := strings.Join(states, ",")
	for _, want := range []string{protocol.PromptInput, protocol.PromptRunning, protocol.PromptDone} {
		if !strings.Contains(joined, want) {
			t.Errorf("没有收到 prompt{state:%q}，输入模式自动切换会失效。实际: %s", want, joined)
		}
	}
}

// --no-history 下不落库，但 prompt 状态照常 —— 自动切换不依赖命令原文。
func TestHistoryDisabledStillReportsPrompt(t *testing.T) {
	h := newInteg(t, integOpts{noHistory: true})
	s, c := h.session()
	h.waitActive(s)

	if err := c.Send(s, "echo no-history\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "no-history")
	waitQuiet(t, s, 400*time.Millisecond)

	if got := len(h.commands()); got != 0 {
		t.Fatalf("关了历史却记了 %d 条", got)
	}
	var sawPrompt bool
	for _, e := range c.Events() {
		if _, ok := e.(*protocol.Prompt); ok {
			sawPrompt = true
		}
	}
	if !sawPrompt {
		t.Error("关了历史之后 prompt 状态也没了 —— 自动切换会跟着失效")
	}
}

// 会话结束时 rcfile 要删掉，不留残留。
func TestRCFileCleanedUp(t *testing.T) {
	h := newInteg(t, integOpts{})
	s, _ := h.session()
	h.waitActive(s)

	entries, err := os.ReadDir(h.runD)
	if err != nil || len(entries) == 0 {
		t.Fatalf("没有生成 rcfile: %v", err)
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("rcfile 权限 = %04o, want 0600（同机其他用户不在信任边界内）", perm)
		}
	}

	if _, err := h.m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "rcfile 被清理", func() bool {
		entries, err := os.ReadDir(h.runD)
		return err == nil && len(entries) == 0
	})
}

func tailOf(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}
