package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sunhaijun/webterm/internal/agent"
)

// commonFlags are the location flags shared by every subcommand.
type commonFlags struct {
	dataDir string
	domain  string
	dev     bool
}

func (c *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.dataDir, "data-dir", defaultDataDir(), "data directory")
	fs.StringVar(&c.domain, "domain", "", "domain name or public IPv4 address (required in production; used for ACME and Origin checks)")
	fs.BoolVar(&c.dev, "dev", false, "local development: plain HTTP on 127.0.0.1, no certificate")
}

// baseURL returns the service address shown to the user; the pairing URL and
// QR code are built from it. Production uses agent.ExternalURL, which keeps any
// port other than 443 (without it, the scanned code would not open).
func (c *commonFlags) baseURL(httpPort, httpsPort int) string {
	if c.dev {
		return "http://127.0.0.1:" + strconv.Itoa(httpPort)
	}
	return agent.ExternalURL(c.domain, httpsPort)
}

// envList collects repeatable --session-env KEY=VAL flags (AC-7.8).
//
// Each entry is validated when parsed. A bad environment variable is hard to
// spot after the fact, so it should fail at startup instead of showing up later
// as an unexplained empty variable inside some session.
type envList []string

func (e *envList) String() string { return strings.Join(*e, " ") }

// fixedSessionEnv lists variables that webterm sets itself and users cannot
// override: TERM determines capability matching with xterm.js, and
// WEBTERM_SESSION identifies the session.
var fixedSessionEnv = map[string]string{
	"TERM":            "it is fixed to xterm-256color, the closest match to xterm.js's capabilities",
	"WEBTERM_SESSION": "it is the session ID assigned by the agent",
}

func (e *envList) Set(v string) error {
	k, _, ok := strings.Cut(v, "=")
	if !ok || k == "" {
		return fmt.Errorf("want KEY=VAL, got %q", v)
	}
	if strings.ContainsAny(k, " \t\n\r\x00=") {
		return fmt.Errorf("invalid variable name %q: must not contain whitespace", k)
	}
	if why, bad := fixedSessionEnv[k]; bad {
		return fmt.Errorf("%s cannot be set with --session-env: %s", k, why)
	}
	*e = append(*e, v)
	return nil
}

// defaultDataDir follows XDG: $XDG_DATA_HOME/webterm, else ~/.local/share/webterm.
func defaultDataDir() string {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "webterm")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".webterm"
	}
	return filepath.Join(home, ".local", "share", "webterm")
}
