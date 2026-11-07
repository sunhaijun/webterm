package attach

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// Options configure Run.
type Options struct {
	Socket string // the agent's attach socket, <data-dir>/run/attach.sock
	Target string // "", a position, or a name (ADR-0050 §4)
	New    bool   // create a session instead of picking one
	List   bool   // print the list and return
	In     *os.File
	Out    *os.File
	Self   uint16 // the session this command runs in (WEBTERM_SESSION), 0 if none

	// ReconnectFor bounds how long a dropped connection is retried
	// (default 30 seconds).
	ReconnectFor time.Duration
}

var (
	// ErrNoAgent means nothing serves the attach socket.
	ErrNoAgent = errors.New("webterm isn't running for this user (no attach socket)")
	errGone    = errors.New("the session is gone (closed elsewhere, or the agent restarted)")
	errLost    = errors.New("lost the connection to the agent")
	errGap     = errors.New("output gap")
)

const (
	maxPending     = 256 << 10 // unacknowledged input, as the browser (protocol §5.4)
	pingEvery      = 30 * time.Second
	resizeDebounce = 100 * time.Millisecond
	retryEvery     = 250 * time.Millisecond
)

// Run lists, picks and attaches according to o. It returns nil when the user
// detaches (ssh closed), the session exits, or the session is closed.
func Run(ctx context.Context, o Options) error {
	if o.ReconnectFor <= 0 {
		o.ReconnectFor = 30 * time.Second
	}
	c := &client{o: o, clientID: newClientID()}
	if err := c.connect(ctx, []protocol.ResumeReq{}, 5*time.Second); err != nil {
		return err
	}
	defer c.closeLink()

	entries := Entries(c.welcome.Sessions, o.Self)
	if o.List {
		_, err := io.WriteString(o.Out, FormatList(entries, c.welcome.Home))
		return err
	}
	choice := Choice{New: o.New}
	if !o.New {
		var err error
		if choice, err = Pick(entries, o.Target); err != nil {
			return err
		}
	}
	if !isTerminal(o.In) || !isTerminal(o.Out) {
		return ErrNoTerminal
	}
	if choice.Prompt != nil {
		var quit bool
		var err error
		if choice, quit, err = c.prompt(choice.Prompt); err != nil || quit {
			return err
		}
	}
	return c.attach(ctx, choice)
}

type inFrame struct {
	binary bool
	data   []byte
}

// link is one connection to the agent. A reader goroutine feeds frames; the
// channel closes when the connection ends.
type link struct {
	ws     *websocket.Conn
	frames chan inFrame
	cancel context.CancelFunc
}

type chunk struct {
	seq  uint64
	data []byte
}

type client struct {
	o        Options
	clientID string
	link     *link
	welcome  *protocol.Welcome

	sid                uint16
	synced             bool // a snapshot has been drawn since (re)subscribing
	snap               []byte
	outSeq             uint64
	sessCols, sessRows uint16
	myCols, myRows     uint16
	lastByte           byte

	inNext       uint64
	pending      []chunk
	pendingBytes int

	exited    bool
	exitCode  *int
	exitHead  uint64
	exitShown bool
	farewell  string // printed after the terminal is restored
}

func newClientID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "attach-" + hex.EncodeToString(b[:])
}

// ---------- connection ----------

func dialLink(ctx context.Context, path string) (*link, error) {
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(dctx, "ws://webterm/ws", &websocket.DialOptions{
		HTTPClient:      hc,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			return nil, &refusedError{}
		}
		return nil, err
	}
	ws.SetReadLimit(8 << 20)
	rctx, rcancel := context.WithCancel(context.Background())
	l := &link{ws: ws, frames: make(chan inFrame, 256), cancel: rcancel}
	go func() {
		defer close(l.frames)
		for {
			typ, data, err := ws.Read(rctx)
			if err != nil {
				return
			}
			select {
			case l.frames <- inFrame{binary: typ == websocket.MessageBinary, data: data}:
			case <-rctx.Done():
				return
			}
		}
	}()
	go func() { // the heartbeat (protocol §5.5), from the prompt on
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-t.C:
				b, _ := protocol.Encode(&protocol.Ping{TS: time.Now().UnixMilli()})
				wctx, cancel := context.WithTimeout(rctx, 5*time.Second)
				_ = ws.Write(wctx, websocket.MessageText, b)
				cancel()
			}
		}
	}()
	return l, nil
}

type refusedError struct{}

func (*refusedError) Error() string {
	return "the agent refused the connection: it runs as another user"
}

func (c *client) closeLink() {
	if c.link == nil {
		return
	}
	c.link.cancel()
	_ = c.link.ws.Close(websocket.StatusNormalClosure, "")
	c.link = nil
}

// connect dials the socket, retrying for up to wait (an agent in the middle of
// a hot upgrade refuses connections for a moment), and exchanges hello and
// welcome.
func (c *client) connect(ctx context.Context, resume []protocol.ResumeReq, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		l, err := dialLink(ctx, c.o.Socket)
		if err == nil {
			c.link = l
			break
		}
		var refused *refusedError
		switch {
		case errors.As(err, &refused):
			return err
		case c.welcome == nil && errors.Is(err, syscall.ENOENT):
			return fmt.Errorf("%w: %s", ErrNoAgent, c.o.Socket)
		case time.Now().After(deadline):
			if c.welcome == nil {
				return fmt.Errorf("the agent isn't answering on %s: %w", c.o.Socket, err)
			}
			return errLost
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(retryEvery):
		}
	}
	instance := ""
	if c.welcome != nil {
		instance = c.welcome.InstanceID
	}
	c.send(&protocol.Hello{Protocol: protocol.Version, ClientID: c.clientID, InstanceID: instance, Resume: resume})
	timeout := time.After(10 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout:
			return errLost
		case f, ok := <-c.link.frames:
			if !ok {
				return errLost
			}
			if f.binary {
				continue
			}
			msg, err := protocol.Decode(f.data)
			if err != nil {
				continue
			}
			switch m := msg.(type) {
			case *protocol.Welcome:
				c.welcome = m
				return nil
			case *protocol.Error:
				return fmt.Errorf("the agent said: %s", m.Message)
			}
		}
	}
}

func (c *client) send(msg any) {
	if c.link == nil {
		return
	}
	b, err := protocol.Encode(msg)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.link.ws.Write(ctx, websocket.MessageText, b)
}

func (c *client) sendFrame(f protocol.Frame) {
	if c.link == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.link.ws.Write(ctx, websocket.MessageBinary, protocol.EncodeFrame(f))
}

// ---------- prompt ----------

// prompt shows entries and reads a choice in cooked mode. EOF (Ctrl+D) quits.
func (c *client) prompt(entries []Entry) (Choice, bool, error) {
	_, _ = io.WriteString(c.o.Out, FormatList(entries, c.welcome.Home))
	buf := make([]byte, 256)
	for {
		_, _ = io.WriteString(c.o.Out, PromptText(entries))
		n, err := c.o.In.Read(buf)
		if n == 0 || err != nil {
			_, _ = io.WriteString(c.o.Out, "\n")
			return Choice{}, true, nil
		}
		if ch, quit, ok := Answer(entries, string(buf[:n])); ok {
			return ch, quit, nil
		}
	}
}

// ---------- attached ----------

func (c *client) attach(ctx context.Context, choice Choice) (err error) {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	defer signal.Stop(winch)

	restore, err := makeRaw(c.o.In)
	if err != nil {
		return err
	}
	c.write([]byte(titlePush))
	defer func() {
		c.write([]byte(exitReset + titlePop))
		restore()
		if c.farewell != "" {
			_, _ = io.WriteString(c.o.Out, c.farewell+"\r\n")
		}
	}()

	c.myCols, c.myRows = termSize(c.o.Out)
	if choice.New {
		if err := c.create(ctx); err != nil {
			return err
		}
	} else {
		c.sid = choice.SID
		for _, s := range c.welcome.Sessions {
			if s.SID == c.sid {
				c.noteSession(s)
			}
		}
	}
	c.subscribe()

	stdin := c.readStdin()
	var resize <-chan time.Time
	for {
		in := stdin
		if c.pendingBytes >= maxPending {
			in = nil // let the terminal's own buffer hold the rest until acks arrive
		}
		var frames chan inFrame
		if c.link != nil {
			frames = c.link.frames
		}
		select {
		case <-ctx.Done():
			return nil // ssh closed, or told to stop: the session keeps running
		case f, ok := <-frames:
			if !ok {
				if err := c.reconnect(ctx); err != nil {
					return c.ended(ctx, err)
				}
				continue
			}
			done, err := c.handle(f)
			if errors.Is(err, errGap) {
				c.closeLink()
				if err := c.reconnect(ctx); err != nil {
					return c.ended(ctx, err)
				}
				continue
			}
			if err != nil || done {
				return err
			}
		case b, ok := <-in:
			if !ok {
				return nil // the terminal is gone
			}
			if c.onStdin(b) {
				return nil
			}
		case <-winch:
			resize = time.After(resizeDebounce)
		case <-resize:
			resize = nil
			c.myCols, c.myRows = termSize(c.o.Out)
			c.claim()
		}
	}
}

// ended turns how the loop ended into Run's result.
func (c *client) ended(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return nil // detached while reconnecting
	}
	return err
}

// create makes a new session and waits for it.
func (c *client) create(ctx context.Context) error {
	const reqID = "attach-new"
	c.send(&protocol.SessionCreate{ReqID: reqID, Cols: c.myCols, Rows: c.myRows})
	timeout := time.After(10 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout:
			return errors.New("the agent didn't create the session")
		case f, ok := <-c.link.frames:
			if !ok {
				return errLost
			}
			if f.binary {
				continue
			}
			msg, err := protocol.Decode(f.data)
			if err != nil {
				continue
			}
			switch m := msg.(type) {
			case *protocol.SessionCreated:
				if m.ReqID == reqID {
					c.sid = m.Session.SID
					c.noteSession(m.Session)
					return nil
				}
			case *protocol.Error:
				if m.ReqID == reqID {
					return errors.New(m.Message)
				}
			}
		}
	}
}

func (c *client) noteSession(s protocol.SessionInfo) {
	if s.Attention {
		c.seen() // attached is looking (ADR-0052 §2)
	}
	c.sessCols, c.sessRows = s.Cols, s.Rows
	if s.Status == protocol.StatusExited {
		c.exited, c.exitCode, c.exitHead = true, s.ExitCode, s.HeadSeq
	}
}

// seen clears the attached session's attention: being attached is looking at
// it (ADR-0052 §2).
func (c *client) seen() {
	c.send(&protocol.SessionSeen{SID: c.sid})
}

// subscribe asks for a snapshot (never incremental: replayed bytes would make
// the local terminal answer old queries on stdin, ADR-0050 §3) and claims the
// size: attaching is using the session.
func (c *client) subscribe() {
	c.synced, c.snap = false, nil
	c.send(&protocol.Subscribe{SID: c.sid, OutSeq: 0, Cols: c.myCols, Rows: c.myRows})
	c.sessCols, c.sessRows = c.myCols, c.myRows
}

// claim sends this terminal's size if the session has another one.
func (c *client) claim() {
	if c.exited || (c.sessCols == c.myCols && c.sessRows == c.myRows) {
		return
	}
	c.send(&protocol.Resize{SID: c.sid, Cols: c.myCols, Rows: c.myRows})
	c.sessCols, c.sessRows = c.myCols, c.myRows // session.updated confirms or corrects it
}

// reconnect replaces a dropped connection: resume with out_seq 0 (a fresh
// snapshot), trim pending input by in_ack and resend the rest. It doesn't
// claim the size: a reconnect isn't the user doing anything.
func (c *client) reconnect(ctx context.Context) error {
	c.closeLink()
	c.synced, c.snap = false, nil
	if err := c.connect(ctx, []protocol.ResumeReq{{SID: c.sid, OutSeq: 0}}, c.o.ReconnectFor); err != nil {
		return err
	}
	for _, r := range c.welcome.Resumed {
		if r.SID != c.sid {
			continue
		}
		if r.Status == protocol.ResumeGone {
			return errGone
		}
		c.trim(r.InAck)
	}
	for _, s := range c.welcome.Sessions {
		if s.SID == c.sid {
			c.noteSession(s)
		}
	}
	for _, p := range c.pending {
		c.sendFrame(protocol.Frame{Type: protocol.TypeInput, SID: c.sid, Seq: p.seq, Payload: p.data})
	}
	return nil
}

// handle processes one frame from the agent. done ends the attach.
func (c *client) handle(f inFrame) (done bool, err error) {
	if f.binary {
		fr, err := protocol.DecodeFrame(f.data)
		if err != nil || fr.SID != c.sid {
			return false, nil
		}
		switch fr.Type {
		case protocol.TypeSnapshot:
			c.snap = append(c.snap, fr.Payload...)
			if fr.More() {
				return false, nil
			}
			c.write([]byte(beforeSnapshot))
			c.write(c.snap)
			c.snap, c.synced, c.outSeq = nil, true, fr.Seq
		case protocol.TypeOutput:
			if !c.synced {
				return false, nil
			}
			end := fr.Seq + uint64(len(fr.Payload))
			switch {
			case fr.Seq > c.outSeq:
				return false, errGap
			case end <= c.outSeq:
				return false, nil // already have it
			}
			c.write(fr.Payload[c.outSeq-fr.Seq:])
			c.outSeq = end
		}
		c.maybeExitLine()
		return false, nil
	}

	msg, err := protocol.Decode(f.data)
	if err != nil {
		return false, nil // unknown types are ignored (protocol §4)
	}
	switch m := msg.(type) {
	case *protocol.SessionUpdated:
		if m.SID != c.sid {
			break
		}
		if m.Cols != nil && m.Rows != nil {
			c.sessCols, c.sessRows = *m.Cols, *m.Rows
		}
		if m.Attention != nil && *m.Attention {
			c.seen()
		}
		if m.Status != nil && *m.Status == protocol.StatusExited {
			c.exited, c.exitCode = true, m.ExitCode
			if m.HeadSeq != nil {
				c.exitHead = *m.HeadSeq
			}
			c.maybeExitLine()
		}
	case *protocol.SessionClosed:
		if m.SID == c.sid {
			if !c.exitShown {
				c.farewell = "[Session closed]"
			}
			return true, nil
		}
	case *protocol.Ack:
		if m.SID == c.sid {
			c.trim(m.InAck)
		}
	case *protocol.Error:
		if m.SID != nil && *m.SID == c.sid && m.Code == protocol.CodeUnknownSession {
			return true, errGone
		}
	}
	return false, nil
}

// maybeExitLine shows the exit line once the session's last output is drawn.
func (c *client) maybeExitLine() {
	if !c.exited || c.exitShown || !c.synced || c.outSeq < c.exitHead {
		return
	}
	c.exitShown = true
	c.write([]byte(exitLine(c.exitCode, c.lastByte == '\n' || c.lastByte == '\r' || c.lastByte == 0)))
}

// onStdin handles one read from the terminal. It returns true to end the
// attach.
func (c *client) onStdin(b []byte) bool {
	if c.exited {
		// As in the browser: Enter closes the exited session. Any other key
		// leaves it (exited, still listed) and detaches. The terminal's own
		// reports (focus, ...) are neither.
		switch {
		case IsReport(b):
			return false
		case string(b) == "\r":
			c.send(&protocol.SessionClose{ReqID: "attach-close", SID: c.sid})
		}
		return true
	}
	if !IsReport(b) {
		c.claim() // the user is typing here (ADR-0050 §5)
	}
	data := append([]byte(nil), b...)
	p := chunk{seq: c.inNext, data: data}
	c.inNext += uint64(len(data))
	c.pending = append(c.pending, p)
	c.pendingBytes += len(data)
	if c.link != nil { // otherwise the reconnect resends it
		c.sendFrame(protocol.Frame{Type: protocol.TypeInput, SID: c.sid, Seq: p.seq, Payload: data})
	}
	return false
}

// trim drops input the agent has written to the PTY.
func (c *client) trim(inAck uint64) {
	for len(c.pending) > 0 {
		p := c.pending[0]
		end := p.seq + uint64(len(p.data))
		if end <= inAck {
			c.pending = c.pending[1:]
			c.pendingBytes -= len(p.data)
			continue
		}
		if p.seq < inAck {
			cut := int(inAck - p.seq)
			c.pending[0] = chunk{seq: inAck, data: p.data[cut:]}
			c.pendingBytes -= cut
		}
		break
	}
}

// readStdin reads the terminal in a goroutine. The channel closes when the
// terminal goes away.
func (c *client) readStdin() <-chan []byte {
	ch := make(chan []byte)
	go func() {
		defer close(ch)
		buf := make([]byte, 32<<10)
		for {
			n, err := c.o.In.Read(buf)
			if n > 0 {
				ch <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return ch
}

func (c *client) write(b []byte) {
	if len(b) == 0 {
		return
	}
	_, _ = c.o.Out.Write(b)
	c.lastByte = b[len(b)-1]
}
