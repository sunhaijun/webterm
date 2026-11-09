package main

import (
	"flag"
	"io"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

// baseURL is the only entry point the user gets: the pairing URL and QR code
// are built from it. Dropping a non-default port means the scanned code does
// not open when 443 is taken (see the non-standard port section of
// docs/80-ops/install.md).
func TestBaseURL(t *testing.T) {
	cases := []struct {
		name      string
		dev       bool
		domain    string
		httpPort  int
		httpsPort int
		want      string
	}{
		{
			"--dev uses loopback and the HTTP port",
			true, "", 8080, 443,
			"http://127.0.0.1:8080",
		},
		{
			"--dev follows a custom HTTP port",
			true, "", 18080, 443,
			"http://127.0.0.1:18080",
		},
		{
			"production on 443 omits the port",
			false, "term.example.com", 80, 443,
			"https://term.example.com",
		},
		{
			// The motivating case: 443 is taken by another service.
			"production on another port includes it",
			false, "term.example.com", 80, 8443,
			"https://term.example.com:8443",
		},
		{
			"production on 8080 includes it too",
			false, "term.example.com", 80, 8080,
			"https://term.example.com:8080",
		},
		{
			// 0 can only mean the caller forgot to pass it; treat it as 443
			// rather than appending ":0".
			"httpsPort 0 is treated as 443",
			false, "term.example.com", 80, 0,
			"https://term.example.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &commonFlags{domain: tc.domain, dev: tc.dev}
			if got := c.baseURL(tc.httpPort, tc.httpsPort); got != tc.want {
				t.Errorf("baseURL(%d, %d) = %q, want %q", tc.httpPort, tc.httpsPort, got, tc.want)
			}
		})
	}
}

// The pairing URL carries the code in the fragment (AC-1.5) and keeps the port.
func TestPairURLKeepsPortAndFragment(t *testing.T) {
	c := &commonFlags{domain: "term.example.com"}
	got := c.baseURL(80, 8443) + "/pair#abc123"
	want := "https://term.example.com:8443/pair#abc123"
	if got != want {
		t.Errorf("pairing URL = %q, want %q", got, want)
	}
}

// UT-cli-flags (AC-8.8): flags are read wherever they sit among a command's
// arguments. Go's flag package stops at the first argument, so
// `devices revoke-all --data-dir X` used to ignore --data-dir and act on the
// default data directory, which on a server is the live service's.
func TestParseInterleaved(t *testing.T) {
	cases := []struct {
		args    []string
		dataDir string
		on      bool
		pos     []string
	}{
		{[]string{"revoke-all", "--data-dir", "X"}, "X", false, []string{"revoke-all"}},
		{[]string{"--data-dir", "X", "revoke-all"}, "X", false, []string{"revoke-all"}},
		{[]string{"revoke", "abc", "--data-dir=X"}, "X", false, []string{"revoke", "abc"}},
		{[]string{"work", "--on", "-data-dir", "X"}, "X", true, []string{"work"}},
		{[]string{"a", "--", "--data-dir", "X"}, "default", false, []string{"a", "--data-dir", "X"}},
		{[]string{"--", "-x"}, "default", false, []string{"-x"}},
		{nil, "default", false, nil},
	}
	for _, c := range cases {
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		dir := fs.String("data-dir", "default", "")
		on := fs.Bool("on", false, "")
		pos, err := parseInterleaved(fs, c.args)
		if err != nil {
			t.Fatalf("%q: %v", c.args, err)
		}
		if *dir != c.dataDir || *on != c.on || !slices.Equal(pos, c.pos) {
			t.Errorf("%q: data-dir %q on %v args %q; want %q %v %q", c.args, *dir, *on, pos, c.dataDir, c.on, c.pos)
		}
	}
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.String("data-dir", "default", "")
	if _, err := parseInterleaved(fs, []string{"revoke-all", "--date-dir", "X"}); err == nil {
		t.Error("an unknown flag after an argument was accepted")
	}
}

// UT-cli-flags (AC-8.8): `webterm devices revoke-all --data-dir X` revokes the
// devices in X and nowhere else.
func TestDevicesFlagAfterCommand(t *testing.T) {
	// Point every default somewhere harmless first: a mistake here must not
	// reach the data directory of a service running on this machine.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	target, other := t.TempDir(), filepath.Join(home, "data", "webterm")
	now := time.Now()
	for _, dir := range []string{target, other} {
		st, err := store.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.CreateDevice("dev-"+filepath.Base(dir), "Mac · Chrome", "token-"+dir, "127.0.0.1", "", now); err != nil {
			t.Fatal(err)
		}
		st.Close()
	}
	if err := runDevices([]string{"revoke-all", "--data-dir", target}); err != nil {
		t.Fatal(err)
	}
	active := func(dir string) int {
		st, err := store.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		devs, err := st.ListDevices()
		if err != nil {
			t.Fatal(err)
		}
		return len(devs) // ListDevices lists the active ones
	}
	if n := active(target); n != 0 {
		t.Errorf("--data-dir after the command: %d device(s) still active there", n)
	}
	if n := active(other); n != 1 {
		t.Errorf("the default data directory was touched: %d active device(s), want 1", n)
	}
}
