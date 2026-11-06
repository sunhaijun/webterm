package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Local attach socket (ADR-0050): `<data-dir>/run/attach.sock`, mode 0600.
//
// `webterm attach` reaches the agent through it, usually from a terminal that
// came in through sshd. It serves GET /ws with exactly the protocol the browser
// speaks on the network. There is no cookie and no Origin: file permissions
// and the peer's uid are the authentication, as for the control socket.

// AttachServer is a listening attach socket.
type AttachServer struct {
	srv  *http.Server
	ln   net.Listener
	path string
	fi   os.FileInfo // the socket file we created, so Close removes only that
}

type connKey struct{}

// ServeAttach opens the attach socket at path. A stale socket file (left by a
// crash, or by the process that just exec'd into this one) is replaced; one an
// agent still answers on is left alone (ErrAgentRunning).
func (a *Agent) ServeAttach(path string) (*AttachServer, error) {
	return a.serveAttach(path, uint32(os.Getuid()))
}

// serveAttach is ServeAttach with the uid peers must have; tests pass another
// one to see a peer refused.
func (a *Agent) serveAttach(path string, uid uint32) (*AttachServer, error) {
	if ControlInUse(path) {
		return nil, fmt.Errorf("%w (%s)", ErrAgentRunning, path)
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("attach socket %s: %w", path, err)
	}
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false) // Close removes the file, and only if it is still ours
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod attach socket: %w", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		ln.Close()
		return nil, fmt.Errorf("attach socket %s: %w", path, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, _ := r.Context().Value(connKey{}).(net.Conn)
		if err := checkPeer(conn, uid); err != nil {
			a.log.Warn("attach connection refused", "err", err)
			a.writeError(w, http.StatusForbidden, "forbidden", "Only the agent's own user can attach")
			return
		}
		a.serveConn(w, r, nil)
	})
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          a.httpErrorLog(),
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, connKey{}, c)
		},
	}
	as := &AttachServer{srv: srv, ln: ln, path: path, fi: fi}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.log.Error("attach socket stopped", "err", err)
		}
	}()
	return as, nil
}

// Path returns the socket path.
func (s *AttachServer) Path() string { return s.path }

// Close stops listening and removes the socket file if it is still the one
// this server created. Attached connections were hijacked by the WebSocket
// upgrade; they belong to the hub and close with it.
func (s *AttachServer) Close() error {
	err := s.srv.Close()
	if fi, serr := os.Stat(s.path); serr == nil && os.SameFile(fi, s.fi) {
		_ = os.Remove(s.path)
	}
	return err
}

// checkPeer verifies that the process on the other end of a Unix socket runs
// as uid (SO_PEERCRED).
func checkPeer(c net.Conn, uid uint32) error {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return errors.New("not a Unix socket connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if credErr != nil {
		return fmt.Errorf("peer credentials: %w", credErr)
	}
	if cred.Uid != uid {
		return fmt.Errorf("peer uid %d, agent uid %d", cred.Uid, uid)
	}
	return nil
}
