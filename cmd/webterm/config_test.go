package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newFS builds a FlagSet with a few common flags, standing in for serve.
func newFS() (*flag.FlagSet, *string, *int, *bool) {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	domain := fs.String("domain", "", "")
	port := fs.Int("https-port", 443, "")
	noLogin := fs.Bool("no-login-shell", false, "")
	return fs, domain, port, noLogin
}

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigFileFillsFlags(t *testing.T) {
	path := write(t, `
# comment

domain     = term.example.com
https-port = 8443
no-login-shell = true
`)
	fs, domain, port, noLogin := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if *domain != "term.example.com" {
		t.Errorf("domain = %q", *domain)
	}
	if *port != 8443 {
		t.Errorf("https-port = %d", *port)
	}
	if !*noLogin {
		t.Error("no-login-shell should be true")
	}
}

// The command line must win over the config file; otherwise a one-off change
// means editing the file.
func TestCommandLineOverridesConfigFile(t *testing.T) {
	path := write(t, "domain = from-file.example.com\nhttps-port = 8443\n")
	fs, domain, port, _ := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse([]string{"--domain", "from-argv.example.com"}); err != nil {
		t.Fatal(err)
	}
	if *domain != "from-argv.example.com" {
		t.Errorf("command line did not override the config file: domain = %q", *domain)
	}
	if *port != 8443 {
		t.Errorf("keys not given on the command line should keep the file's value: https-port = %d", *port)
	}
}

// A misspelled key must fail immediately and name the line. Silently ignoring
// it is the hardest kind of bug to track down.
func TestUnknownKeyIsAnErrorWithLineNumber(t *testing.T) {
	path := write(t, "domain = a.example.com\n\nhttpsport = 8443\n")
	fs, _, _, _ := newFS()
	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("misspelled key was accepted")
	}
	for _, want := range []string{"httpsport", ":3", "unknown option"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q: %v", want, err)
		}
	}
}

// Keys belonging to another subcommand are skipped, not treated as typos: one
// config file is shared by every subcommand.
func TestKeyOfAnotherSubcommandIsSkipped(t *testing.T) {
	path := write(t, "domain = a.example.com\nmax-sessions = 5\n")
	fs, domain, _, _ := newFS() // this FlagSet has no max-sessions
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatalf("a valid key for another subcommand should not fail: %v", err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if *domain != "a.example.com" {
		t.Errorf("domain = %q", *domain)
	}
}

// --dev and --config are not allowed in the config file; see configKeys.
func TestDevAndConfigAreRejected(t *testing.T) {
	for _, key := range []string{"dev", "config"} {
		path := write(t, key+" = true\n")
		fs, _, _, _ := newFS()
		if err := loadConfigInto(fs, path); err == nil {
			t.Errorf("%q should not be allowed in the config file", key)
		}
	}
}

// A missing file is not an error; most users do not need one.
func TestMissingConfigFileIsFine(t *testing.T) {
	fs, _, _, _ := newFS()
	if err := loadConfigInto(fs, filepath.Join(t.TempDir(), "nope")); err != nil {
		t.Errorf("missing config file should not be an error: %v", err)
	}
}

// A bare boolean key means true.
func TestBareBooleanKey(t *testing.T) {
	path := write(t, "no-login-shell\n")
	fs, _, _, noLogin := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if !*noLogin {
		t.Error("a bare boolean key should mean true")
	}
}

// An invalid value must point at the config file, so it is not mistaken for a
// command-line typo.
func TestBadValueMentionsTheFile(t *testing.T) {
	path := write(t, "https-port = not-a-number\n")
	fs, _, _, _ := newFS()
	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("invalid value was accepted")
	}
	if !strings.Contains(err.Error(), "https-port") || !strings.Contains(err.Error(), ":1") {
		t.Errorf("error should name the key and line: %v", err)
	}
}

// Drift guard: every allowlisted key must be a real serve flag. Without this,
// renaming a flag would silently break config files.
func TestConfigKeysAllExistOnServe(t *testing.T) {
	fs := serveFlagSet()
	for key := range configKeys {
		if fs.Lookup(key) == nil {
			t.Errorf("configKeys has %q, which is not a serve flag; config files using it would silently stop working", key)
		}
	}
}

// The reverse: every serve flag that should be configurable is allowlisted.
func TestServeFlagsAreConfigurable(t *testing.T) {
	// These are deliberately excluded. handoff-fd is internal: the old process
	// passes it at exec during a hot upgrade (ADR-0016), and in a config file
	// it would make serve read an fd that does not exist.
	excluded := map[string]bool{"dev": true, "config": true, "handoff-fd": true}
	fs := serveFlagSet()
	fs.VisitAll(func(f *flag.Flag) {
		if excluded[f.Name] || configKeys[f.Name] {
			return
		}
		t.Errorf("serve has --%s but configKeys does not; add it, or add it to excluded with a reason", f.Name)
	})
}

// UT-config-removed-key: a removed key (acme-staging, ADR-0044 §3) reports
// "has been removed" with the line number, not "unknown option", which would
// make people suspect a typo.
func TestConfigRemovedKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("domain = x.example.com\nacme-staging = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.String("domain", "", "")
	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("acme-staging was accepted; ignoring it silently would suggest it still works")
	}
	for _, want := range []string{":2:", "has been removed", "Delete this line"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q: %v", want, err)
		}
	}
}
