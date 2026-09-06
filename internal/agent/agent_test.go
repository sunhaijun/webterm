package agent_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// 端到端：配对 → 建 WebSocket → 建会话 → 敲命令 → 看到输出。
// 这是 m2 的出口标准（原本靠手工 wscat 验证，这里自动化掉）。
func TestEndToEndPairAndRunCommand(t *testing.T) {
	h := newHarness(t)
	c := h.client()

	resp := h.pair(c)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("配对返回 %d", resp.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")

	w := cl.welcome()
	if w.Protocol != protocol.Version {
		t.Fatalf("welcome.protocol = %d", w.Protocol)
	}
	if w.InstanceID == "" {
		t.Fatal("welcome 缺少 instance_id")
	}
	if w.Limits.MaxFrameBytes != protocol.MaxPayload {
		t.Fatalf("limits.max_frame_bytes = %d", w.Limits.MaxFrameBytes)
	}

	sid := cl.createSession(t.TempDir())
	cl.input(sid, "printf 'E2E-%s\\n' OK\r")
	waitFor(t, "终端出现命令输出", func() bool {
		return strings.Contains(cl.screenOf(sid), "E2E-OK")
	})

	// ping / pong
	cl.send(&protocol.Ping{TS: 12345})
	waitFor(t, "收到 pong", func() bool {
		for _, m := range cl.messages() {
			if p, ok := m.(*protocol.Pong); ok && p.TS == 12345 {
				return true
			}
		}
		return false
	})
}

// IT-auth-1：路由认证矩阵，**含 /ws**。
//
// "认证中间件必须覆盖 WebSocket 升级路径"是最容易漏的一条（AC-1.7）。
func TestITAuth1_RouteMatrix(t *testing.T) {
	h := newHarness(t)
	anon := h.client()

	t.Run("不需要认证的路由", func(t *testing.T) {
		for _, p := range []string{"/", "/pair", "/healthz", "/manifest.json"} {
			resp, err := anon.Get(h.srv.URL + p)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("GET %s = %d, want 200", p, resp.StatusCode)
			}
		}
	})

	t.Run("需要认证的路由", func(t *testing.T) {
		for _, tc := range []struct{ method, path string }{
			{"GET", "/api/devices"},
			{"GET", "/api/commands"},
			{"GET", "/api/settings"},
			{"POST", "/api/devices/revoke-all"},
			{"DELETE", "/api/commands?pinned=false"},
		} {
			resp := h.do(anon, tc.method, tc.path, nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s %s = %d, want 401", tc.method, tc.path, resp.StatusCode)
			}
		}
	})

	t.Run("WebSocket 升级也要认证", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, resp, err := h.dial(ctx, anon, h.srv.URL)
		if err == nil {
			t.Fatal("未认证却建连成功了")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("WS 升级 = %v, want 401", resp)
		}
	})

	t.Run("配对之后就能连了", func(t *testing.T) {
		c := h.client()
		h.pair(c).Body.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, _, err := h.dial(ctx, c, h.srv.URL)
		if err != nil {
			t.Fatalf("已认证却连不上: %v", err)
		}
		ws.CloseNow()
	})
}

// IT-auth-2：WebSocket 的 Origin 校验（AC-1.8 / 威胁模型 T4）。
func TestITAuth2_OriginCheck(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("伪造 Origin 被拒", func(t *testing.T) {
		_, resp, err := h.dial(ctx, c, "https://evil.example.com")
		if err == nil {
			t.Fatal("跨站 Origin 却建连成功了")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("状态码 = %v, want 403", resp)
		}
	})

	t.Run("本机 Origin 在 --dev 下放行", func(t *testing.T) {
		ws, _, err := h.dial(ctx, c, h.srv.URL)
		if err != nil {
			t.Fatalf("本机 Origin 被拒: %v", err)
		}
		ws.CloseNow()
	})
}

// IT-auth-3：Cookie 属性（AC-1.9）。
func TestITAuth3_CookieAttributes(t *testing.T) {
	h := newHarness(t)
	resp := h.pair(h.client())
	defer resp.Body.Close()

	var got *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			got = ck
		}
	}
	if got == nil {
		t.Fatal("配对成功却没有下发会话 Cookie")
	}
	if !got.HttpOnly {
		t.Error("Cookie 必须 HttpOnly —— 否则 XSS 能偷走它")
	}
	if got.SameSite != http.SameSiteStrictMode {
		t.Error("Cookie 必须 SameSite=Strict —— 这是 CSRF 的主要防线")
	}
	if got.Path != "/" {
		t.Errorf("Path = %q, want /", got.Path)
	}
	if got.MaxAge < 300*24*3600 {
		t.Errorf("MaxAge = %d，太短了（应当约一年）", got.MaxAge)
	}
	// --dev 下允许缺省 Secure（localhost 是明文但也是 secure context）
	if got.Secure {
		t.Error("--dev 下不该带 Secure，否则 http://localhost 收不到")
	}
}

// AC-1.10：库里存的是 token 的哈希，不是原文。
func TestTokenStoredAsHashOnly(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	resp := h.pair(c)
	resp.Body.Close()

	var token string
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			token = ck.Value
		}
	}
	if token == "" {
		t.Fatal("没拿到 token")
	}
	// 整个数据目录里都不该出现 token 原文
	assertNotInDataDir(t, h.dataDir, token)
}

// IT-auth-4：吊销即时生效 —— 已建立的 WebSocket 在 5 秒内被断开（AC-1.11）。
//
// 不能只在握手时检查：WebSocket 可能挂几天。
func TestITAuth4_RevocationClosesLiveWebSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	devs, err := h.store.ListDevices()
	if err != nil || len(devs) != 1 {
		t.Fatalf("设备列表异常: %v %d", err, len(devs))
	}
	start := time.Now()
	if err := h.store.RevokeDevice(devs[0].ID, time.Now()); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "连接被断开", func() bool { return cl.isClosed() })
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("吊销后过了 %v 才断开，AC-1.11 要求 5 秒内", d)
	}
	// 断开前应当先告诉用户为什么
	var told bool
	for _, m := range cl.messages() {
		if n, ok := m.(*protocol.Notice); ok && strings.Contains(n.Message, "吊销") {
			told = true
		}
	}
	for _, e := range cl.errors() {
		if e.Code == protocol.CodeUnauthorized {
			told = true
		}
	}
	if !told {
		t.Error("断开前没有告知原因，用户只会看到一个莫名的重连失败")
	}
}

// IT-pair-1：配对码单次有效、过期作废（AC-1.4）。
func TestITPair1_CodeIsSingleUse(t *testing.T) {
	h := newHarness(t)
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("第一次配对 = %d, want 200", resp.StatusCode)
	}

	resp2 := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code})
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("同一个码第二次 = %d, want 401（用过即废）", resp2.StatusCode)
	}

	// 限速按 IP 记账，而测试里所有请求都来自 127.0.0.1 —— 下面两条各起
	// 一个干净的 harness，否则会被上面的尝试挤到 429 上去。
	t.Run("过期的码不可用", func(t *testing.T) {
		h := newHarness(t)
		old, err := h.agent.Auth().NewPairingCode(time.Now().Add(-2 * auth.PairingTTL))
		if err != nil {
			t.Fatal(err)
		}
		resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": old})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("过期码 = %d, want 401", resp.StatusCode)
		}
	})

	t.Run("乱猜的码不可用", func(t *testing.T) {
		h := newHarness(t)
		resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": "not-a-real-code"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("错误码 = %d, want 401", resp.StatusCode)
		}
	})
}

// IT-pair-2：配对码不进日志、不进库（AC-1.5 / AC-8.5）。
func TestITPair2_CodeNeverLogged(t *testing.T) {
	h := newHarness(t)
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// 成功一次 + 失败一次，两条路径都要查
	h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code}).Body.Close()
	h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code}).Body.Close()

	if strings.Contains(h.logs.String(), code) {
		t.Fatal("配对码出现在日志里")
	}
	assertNotInDataDir(t, h.dataDir, code)
}

// IT-pair-3：限速（AC-1.6）。
func TestITPair3_RateLimited(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	var got429 bool
	for i := range 8 {
		resp := h.postJSON(c, "/auth/pair", map[string]string{"code": "wrong-code"})
		code := resp.StatusCode
		retryAfter := resp.Header.Get("Retry-After")
		resp.Body.Close()
		if code == http.StatusTooManyRequests {
			got429 = true
			if retryAfter == "" {
				t.Error("429 必须带 Retry-After")
			}
			break
		}
		if i >= 7 {
			t.Fatalf("连试 8 次都没被限速")
		}
	}
	if !got429 {
		t.Fatal("没有触发限速")
	}
}

// IT-privacy-1：终端输出【绝不落盘】（AC-8.4 / 不变式 3）。
func TestITPrivacy1_TerminalOutputNeverPersisted(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	const canary = "WEBTERM_CANARY_9f3a2b"
	// 用 printf 拼出来，让 canary 只出现在【输出】里而不在命令原文里 ——
	// 命令原文是允许落盘的，输出不允许。
	cl.input(sid, "printf 'WEBTERM_CANARY_%s\\n' 9f3a2b\r")
	waitFor(t, "canary 出现在终端", func() bool {
		return strings.Contains(cl.screenOf(sid), canary)
	})
	// 给落库一点时间
	time.Sleep(300 * time.Millisecond)

	assertNotInDataDir(t, h.dataDir, canary)
	if strings.Contains(h.logs.String(), canary) {
		t.Fatal("终端输出出现在日志里")
	}
}

// IT-privacy-2：命令原文不进日志（AC-8.5）。
func TestITPrivacy2_CommandTextNeverLogged(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	const secret = "SUPER_SECRET_COMMAND_TEXT"
	cl.input(sid, "echo "+secret+"\r")
	waitFor(t, "命令被执行", func() bool {
		return strings.Contains(cl.screenOf(sid), secret)
	})
	time.Sleep(200 * time.Millisecond)

	if strings.Contains(h.logs.String(), secret) {
		t.Fatal("命令原文出现在日志里")
	}
}

// IT-sub-1：未订阅的会话照常缓冲，subscribe{out_seq} 能补齐。
func TestITSub1_UnsubscribedSessionKeepsBuffering(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "第一段输出", func() bool { return strings.Contains(cl.screenOf(sid), "BEFORE-MARK") })

	cl.send(&protocol.Unsubscribe{SID: sid})
	time.Sleep(200 * time.Millisecond)
	before := len(cl.screenOf(sid))

	cl.input(sid, "printf 'AFTER-%s\\n' MARK\r")
	// 未订阅期间字节不该过网络
	time.Sleep(500 * time.Millisecond)
	if strings.Contains(cl.screenOf(sid), "AFTER-MARK") {
		t.Fatal("未订阅的会话仍在推送输出 —— 移动端的流量优化失效了")
	}
	// 但 agent 侧照常缓冲，切回去能补齐
	cl.mu.Lock()
	at := cl.outSeq[sid]
	cl.mu.Unlock()
	cl.send(&protocol.Subscribe{SID: sid, OutSeq: at})
	waitFor(t, "切回后补齐了断开期间的输出", func() bool {
		return strings.Contains(cl.screenOf(sid), "AFTER-MARK")
	})
	if len(cl.screenOf(sid)) <= before {
		t.Fatal("补齐没有带来新内容")
	}
}

// IT-hb-1：60 秒没收到任何帧的连接被关闭（AC-2.8）。
// 用可注入的 idle timeout，免得测试真的等一分钟。
func TestITHb1_IdleConnectionClosed(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) { c.WSIdleTimeout = 700 * time.Millisecond })
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	waitFor(t, "空闲连接被关闭", func() bool { return cl.isClosed() })
}

// 心跳能让连接活着：持续 ping 的连接不该被判死。
func TestHeartbeatKeepsConnectionAlive(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) { c.WSIdleTimeout = 700 * time.Millisecond })
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		cl.send(&protocol.Ping{TS: time.Now().UnixMilli()})
		time.Sleep(200 * time.Millisecond)
		if cl.isClosed() {
			t.Fatal("一直在发 ping 的连接却被判死了")
		}
	}
}

// 未知的控制消息必须被【忽略】而不是关连接（协议 §4，前向兼容）。
func TestUnknownControlMessageIgnored(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	raw, _ := json.Marshal(map[string]any{"t": "session.split", "sid": 1})
	if err := cl.ws.Write(ctx, 1 /* text */, raw); err != nil {
		t.Fatal(err)
	}
	// 连接必须活着，而且后续消息照常工作
	cl.send(&protocol.Ping{TS: 999})
	waitFor(t, "未知消息之后 ping 仍然通", func() bool {
		for _, m := range cl.messages() {
			if p, ok := m.(*protocol.Pong); ok && p.TS == 999 {
				return true
			}
		}
		return false
	})
	if cl.isClosed() {
		t.Fatal("收到未知 t 值就关连接了 —— 前向兼容失效")
	}
}

// 协议版本不匹配时给【可读的】错误消息，而不是一个裸的握手失败。
//
// 这正是"不用子协议做版本协商"的理由（协议 §1）。
func TestProtocolVersionMismatch(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connectRaw(ctx, c, "tab-1")
	cl.send(&protocol.Hello{Protocol: 999, ClientID: "tab-1"})

	waitFor(t, "收到 protocol_unsupported", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeProtocolUnsupported {
				if !strings.Contains(e.Message, "999") {
					t.Errorf("错误消息里没写清双方版本: %q", e.Message)
				}
				return true
			}
		}
		return false
	})
	waitFor(t, "随后关闭连接", func() bool { return cl.isClosed() })
}

// 第一条消息不是 hello → expected_hello 并关闭（协议 §4.1）。
func TestFirstMessageMustBeHello(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connectRaw(ctx, c, "tab-1")
	cl.send(&protocol.Ping{TS: 1}) // 不是 hello

	waitFor(t, "收到 expected_hello", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeExpectedHello {
				return true
			}
		}
		return false
	})
	waitFor(t, "随后关闭连接", func() bool { return cl.isClosed() })
}

// assertNotInDataDir grep 整个数据目录，断言 needle 零命中。
func assertNotInDataDir(t *testing.T, dir, needle string) {
	t.Helper()
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if strings.Contains(string(b), needle) {
			t.Errorf("%q 出现在 %s 里", needle, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// IT-queue-2：连接写队列满 → 关闭该连接，而不是阻塞 Session（协议 §5.5）。
//
// 阻塞写会反压到 PTY.Read()，一个慢客户端就能拖慢服务器上真正在跑的活。
func TestITQueue2_SlowClientDisconnectedNotBlocking(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) {
		c.WSWriteQueueMax = 32 << 10 // 调小，让慢客户端保护可测
	})
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	flooding := cl.createSession(t.TempDir())
	other := cl.createSession(t.TempDir())

	// 让客户端停止读，然后灌大量输出把写队列撑爆。
	// 量必须远大于内核 socket 缓冲（几百 KB）—— 不然字节都被内核吸收了，
	// 应用层的队列根本涨不起来。
	cl.stopReading()
	cl.input(flooding, "tr '\\0' 'x' < /dev/zero | head -c 16000000\r")

	// 从【服务端】看它有没有被丢掉 —— 客户端已经不读了，自然也观察不到关闭
	waitFor(t, "慢客户端被服务端丢弃", func() bool { return h.agent.Hub().Count() == 0 })

	// 关键断言：慢客户端不能拖慢"服务器上真正在跑的活"。
	// 另一个会话必须【立刻】响应，而不是等那 16 MB 灌完。
	cl2 := h.connect(ctx, h.reuse(c), "tab-2", nil, "")
	cl2.welcome()
	cl2.send(&protocol.Subscribe{SID: other, OutSeq: 0})
	cl2.input(other, "printf 'ALIVE-%s\\n' OK\r")

	start := time.Now()
	waitFor(t, "另一个会话仍然可用", func() bool {
		return strings.Contains(cl2.screenOf(other), "ALIVE-OK")
	})
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("另一个会话花了 %v 才响应 —— 被慢客户端拖慢了", d)
	}
}

// 断线续传走真实 socket：断开重连后按 out_seq 增量补齐，输入按 in_ack 重发。
func TestResumeOverRealSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	w := cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "第一段输出", func() bool { return strings.Contains(cl.screenOf(sid), "BEFORE-MARK") })

	// 起一个持续产出的循环，好让"断线期间会话不暂停"这条真的可测
	cl.input(sid, "for i in $(seq 1 400); do printf 'tick %03d\\n' $i; sleep 0.01; done\r")
	waitFor(t, "循环开始产出", func() bool { return strings.Contains(cl.screenOf(sid), "tick 001") })

	cl.mu.Lock()
	at := cl.outSeq[sid]
	sentBefore := cl.inSeq[sid]
	cl.mu.Unlock()

	// 硬断连接（模拟网络中断）
	cl.ws.CloseNow()
	waitFor(t, "旧连接消失", func() bool { return cl.isClosed() })

	// 断线期间 PTY 继续跑、环形缓冲继续累积（AC-2.2）
	waitFor(t, "断线期间会话仍在推进", func() bool {
		s, ok := h.sessions.Get(sid)
		return ok && s.HeadSeq() > at
	})

	// 同一个 client_id 重连
	cl2 := h.connect(ctx, c, "tab-1", []protocol.ResumeReq{{SID: sid, OutSeq: at}}, w.InstanceID)
	w2 := cl2.welcome()
	if len(w2.Resumed) != 1 {
		t.Fatalf("resumed = %+v", w2.Resumed)
	}
	r := w2.Resumed[0]
	if r.Status != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", r.Status)
	}
	if r.InAck != sentBefore {
		t.Fatalf("in_ack = %d, want %d —— 跨重连的输入记账没保住", r.InAck, sentBefore)
	}

	// 客户端按 in_ack 裁剪后继续发，不该触发 input_gap
	cl2.mu.Lock()
	cl2.inSeq[sid] = r.InAck
	cl2.mu.Unlock()
	cl2.input(sid, "printf 'AFTER-%s\\n' MARK\r")
	waitFor(t, "重连后输入生效", func() bool {
		return strings.Contains(cl2.screenOf(sid), "AFTER-MARK")
	})
	for _, e := range cl2.errors() {
		if e.Code == protocol.CodeInputGap {
			t.Fatal("重连后触发了 input_gap")
		}
	}
}

// 多标签页：A 新建的会话，B 也要看得到（协议 §4.2 的广播要求）。
func TestSessionEventsBroadcastToAllTabs(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tabA := h.connect(ctx, c, "tab-a", nil, "")
	tabA.welcome()
	tabB := h.connect(ctx, c, "tab-b", nil, "")
	tabB.welcome()

	sid := tabA.createSession(t.TempDir())

	waitFor(t, "B 也收到了 session.created", func() bool {
		for _, m := range tabB.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.Session.SID == sid {
				// req_id 只出现在发起方的副本上
				if v.ReqID != "" {
					t.Errorf("广播给其它标签页的副本不该带 req_id，得到 %q", v.ReqID)
				}
				return true
			}
		}
		return false
	})

	// B 没订阅这个会话，但要能靠 head_seq 算出未读
	tabA.input(sid, "printf 'FOR-%s\\n' A\r")
	waitFor(t, "B 收到 head_seq 更新（未读的依据）", func() bool {
		for _, m := range tabB.messages() {
			if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.HeadSeq != nil {
				return true
			}
		}
		return false
	})
	if strings.Contains(tabB.screenOf(sid), "FOR-A") {
		t.Fatal("B 没订阅却收到了输出字节")
	}
}

// 会话数达上限时回 session_limit，而不是点了没反应（US-7.3 / AC-4.2）。
func TestSessionLimitReported(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	dir := t.TempDir()
	for range 5 { // harness 里 MaxSessions = 5
		cl.createSession(dir)
	}
	cwd := dir
	cl.send(&protocol.SessionCreate{ReqID: "over", CWD: &cwd, Cols: 80, Rows: 24})
	waitFor(t, "收到 session_limit", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeSessionLimit && e.ReqID == "over" {
				return true
			}
		}
		return false
	})
	if cl.isClosed() {
		t.Fatal("会话数超限不该关连接")
	}
}
