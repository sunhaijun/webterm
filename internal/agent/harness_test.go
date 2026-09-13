package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/shellinit"
	"github.com/sunhaijun/webterm/internal/store"
)

// harness 起一个进程内的完整 agent：真 store、真 PTY、真 HTTP、真 WebSocket。
type harness struct {
	t        *testing.T
	srv      *httptest.Server
	agent    *agent.Agent
	store    *store.Store
	sessions *session.Manager
	dataDir  string
	logs     *lockedBuffer
}

// harnessOpts 是夹具的可调项。
type harnessOpts struct {
	ringBytes        int
	shellIntegration bool
	tune             func(*agent.Config)
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func newHarness(t *testing.T, tune ...func(*agent.Config)) *harness {
	return newHarnessWith(t, harnessOpts{tune: chain(tune)})
}

func chain(fns []func(*agent.Config)) func(*agent.Config) {
	return func(c *agent.Config) {
		for _, f := range fns {
			f(c)
		}
	}
}

func newHarnessWith(t *testing.T, o harnessOpts) *harness {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	ring := o.ringBytes
	if ring == 0 {
		ring = 1 << 20
	}
	sessCfg := session.Config{MaxSessions: 5, RingBytes: ring, Shell: "bash", History: true}
	if o.shellIntegration {
		runD := filepath.Join(t.TempDir(), "run")
		sessCfg.RCFileFor = func(sid uint16) (string, error) {
			return shellinit.Render(sid, shellinit.Options{Dir: runD})
		}
	}
	sessions := session.NewManager(sessCfg, st)
	t.Cleanup(sessions.Shutdown)

	logs := &lockedBuffer{}
	cfg := agent.Config{
		Dev:     true, // 允许 localhost Origin，Cookie 省略 Secure
		Version: "test",
		Logger:  slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}
	if o.tune != nil {
		o.tune(&cfg)
	}
	a := agent.New(cfg, st, sessions)
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)

	return &harness{
		t: t, srv: srv, agent: a, store: st, sessions: sessions,
		dataDir: dir, logs: logs,
	}
}

// client 返回一个带 cookie jar 的 HTTP 客户端（模拟一个浏览器）。
func (h *harness) client() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

// pair 走完整的配对流程，返回带会话 Cookie 的客户端。
func (h *harness) pair(c *http.Client) *http.Response {
	h.t.Helper()
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		h.t.Fatal(err)
	}
	return h.postJSON(c, "/auth/pair", map[string]string{"code": code})
}

func (h *harness) postJSON(c *http.Client, path string, body any) *http.Response {
	h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone) Safari/605")
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func (h *harness) do(c *http.Client, method, path string, body any) *http.Response {
	h.t.Helper()
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// reuse 返回同一个 Cookie jar 的新客户端（模拟同一台设备的另一个标签页）。
func (h *harness) reuse(c *http.Client) *http.Client {
	return &http.Client{Jar: c.Jar, Timeout: 10 * time.Second}
}

// wsURL 返回 WebSocket 地址。
func (h *harness) wsURL() string { return "ws" + strings.TrimPrefix(h.srv.URL, "http") + "/ws" }

// dial 用给定客户端的 Cookie 建立 WebSocket。
func (h *harness) dial(ctx context.Context, c *http.Client, origin string) (*websocket.Conn, *http.Response, error) {
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	return websocket.Dial(ctx, h.wsURL(), &websocket.DialOptions{
		HTTPClient: c,
		HTTPHeader: hdr,
	})
}

// wsClient 是一个最小的协议客户端，够用来跑 m2 的集成测试。
type wsClient struct {
	t        *testing.T
	ws       *websocket.Conn
	clientID string

	mu       sync.Mutex
	msgs     []any
	screen   map[uint16]*bytes.Buffer
	outSeq   map[uint16]uint64
	inSeq    map[uint16]uint64
	errs     []*protocol.Error
	closed   bool
	stopRead bool
	reqSeq   int
	attrSeen map[uint16]bool
}

// sawAttrPrefix 报告是否收到过带属性修正前缀的帧（即一次 reset 回放）。
func (c *wsClient) sawAttrPrefix(sid uint16) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attrSeen[sid]
}

// headSeqOf 返回 session.updated 报过的最新 head_seq。
// 未订阅期间字节不过网络，只有这条消息能告诉测试"积压涨到哪了"。
func (c *wsClient) headSeqOf(sid uint16) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var v uint64
	for _, m := range c.msgs {
		if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.HeadSeq != nil {
			v = *u.HeadSeq
		}
	}
	return v
}

// stopReading 让客户端不再从 socket 上取数据，用来撑爆服务端的写队列。
func (c *wsClient) stopReading() {
	c.mu.Lock()
	c.stopRead = true
	c.mu.Unlock()
}

// connectRaw 建连但【不发 hello】，让测试自己决定第一条消息。
func (h *harness) connectRaw(ctx context.Context, c *http.Client, clientID string) *wsClient {
	h.t.Helper()
	ws, _, err := h.dial(ctx, c, h.srv.URL)
	if err != nil {
		h.t.Fatalf("WebSocket 建连失败: %v", err)
	}
	ws.SetReadLimit(4 << 20)
	cl := &wsClient{
		t: h.t, ws: ws, clientID: clientID,
		screen: map[uint16]*bytes.Buffer{},
		outSeq: map[uint16]uint64{},
		inSeq:  map[uint16]uint64{},
	}
	go cl.readLoop(ctx)
	return cl
}

func (h *harness) connect(ctx context.Context, c *http.Client, clientID string, resume []protocol.ResumeReq, instanceID string) *wsClient {
	h.t.Helper()
	cl := h.connectRaw(ctx, c, clientID)
	cl.send(&protocol.Hello{
		Protocol: protocol.Version, ClientID: clientID,
		InstanceID: instanceID, Resume: resume,
	})
	return cl
}

func (c *wsClient) send(msg any) {
	b, err := protocol.Encode(msg)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Logf("发送失败: %v", err)
	}
}

// input 发一段输入，自行维护 in_seq。
func (c *wsClient) input(sid uint16, data string) {
	c.mu.Lock()
	seq := c.inSeq[sid]
	c.inSeq[sid] = seq + uint64(len(data))
	c.mu.Unlock()
	f := protocol.Frame{Type: protocol.TypeInput, SID: sid, Seq: seq, Payload: []byte(data)}
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, protocol.EncodeFrame(f)); err != nil {
		c.t.Logf("发送输入失败: %v", err)
	}
}

func (c *wsClient) readLoop(ctx context.Context) {
	for {
		c.mu.Lock()
		stopped := c.stopRead
		c.mu.Unlock()
		if stopped {
			// 只是不再读，socket 保持打开 —— 服务端的写队列会一路涨到上限
			select {
			case <-ctx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			continue
		}
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			c.mu.Lock()
			c.closed = true
			c.mu.Unlock()
			return
		}
		switch typ {
		case websocket.MessageBinary:
			f, err := protocol.DecodeFrame(data)
			if err != nil {
				continue
			}
			c.mu.Lock()
			buf := c.screen[f.SID]
			if buf == nil {
				buf = &bytes.Buffer{}
				c.screen[f.SID] = buf
			}
			payload := f.Payload
			if f.Flags&protocol.FlagAttrPrefix != 0 {
				buf.Reset() // reset 回放：客户端清屏
				payload = payload[len(protocol.AttrPrefix):]
				if c.attrSeen == nil {
					c.attrSeen = map[uint16]bool{}
				}
				c.attrSeen[f.SID] = true
			}
			buf.Write(payload)
			c.outSeq[f.SID] = f.Seq + uint64(f.DataLen())
			c.mu.Unlock()
		case websocket.MessageText:
			msg, err := protocol.Decode(data)
			if err != nil {
				continue
			}
			c.mu.Lock()
			c.msgs = append(c.msgs, msg)
			if e, ok := msg.(*protocol.Error); ok {
				c.errs = append(c.errs, e)
			}
			c.mu.Unlock()
		}
	}
}

func (c *wsClient) screenOf(sid uint16) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if b := c.screen[sid]; b != nil {
		return b.String()
	}
	return ""
}

func (c *wsClient) messages() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.msgs...)
}

func (c *wsClient) errors() []*protocol.Error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*protocol.Error(nil), c.errs...)
}

func (c *wsClient) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// welcome 等 welcome 消息。
func (c *wsClient) welcome() *protocol.Welcome {
	c.t.Helper()
	var w *protocol.Welcome
	waitFor(c.t, "收到 welcome", func() bool {
		for _, m := range c.messages() {
			if v, ok := m.(*protocol.Welcome); ok {
				w = v
				return true
			}
		}
		return false
	})
	return w
}

// createSession 建一个会话并等它对应的 session.created。
//
// 【必须按 req_id 匹配】：一条连接可能建多个会话，认第一条 session.created
// 会让第二次调用拿回第一个会话的 sid —— 那种 bug 会把后面所有断言都带偏。
func (c *wsClient) createSession(cwd string) uint16 {
	c.t.Helper()
	c.mu.Lock()
	c.reqSeq++
	reqID := "req-" + itoa(c.reqSeq)
	c.mu.Unlock()

	cwdp := cwd
	c.send(&protocol.SessionCreate{ReqID: reqID, CWD: &cwdp, Cols: 80, Rows: 24})
	var sid uint16
	waitFor(c.t, "收到 session.created("+reqID+")", func() bool {
		for _, m := range c.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.ReqID == reqID {
				sid = v.Session.SID
				return true
			}
		}
		return false
	})
	return sid
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("超时等待：%s", what)
}
