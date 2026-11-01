package main

import (
	"flag"
	"os"
	"strings"
	"testing"
)

// --session-env is validated as it is parsed (AC-7.8).
//
// A bad entry must fail at parse time. An environment variable that silently
// did not apply is one of the hardest problems to diagnose later; finding $FOO
// empty in some session and working backwards is far too expensive.
func TestSessionEnvValidation(t *testing.T) {
	cases := []struct {
		name, in, wantErr string
	}{
		{"plain value", "FOO=bar", ""},
		{"value may contain =", "FOO=a=b", ""},
		{"empty value is allowed (some switches only check whether it is set)", "FOO=", ""},
		{"missing =", "FOO", "KEY=VAL"},
		{"empty key", "=bar", "KEY=VAL"},
		{"space in key", "A B=c", "invalid variable name"},
		{"TERM cannot be overridden", "TERM=dumb", "TERM"},
		{"WEBTERM_SESSION cannot be overridden", "WEBTERM_SESSION=9", "WEBTERM_SESSION"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var l envList
			err := l.Set(tc.in)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("Set(%q) failed: %v", tc.in, err)
			case tc.wantErr == "" && len(l) != 1:
				t.Fatalf("after Set(%q) = %v, want the entry accepted", tc.in, l)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("Set(%q) should fail", tc.in)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("Set(%q) error = %q, want it to contain %q so the user can see what is wrong",
					tc.in, err.Error(), tc.wantErr)
			}
		})
	}
}

// The flag is repeatable, and config-file and command-line entries are merged
// rather than one replacing the other.
//
// After merging, command-line entries come last. Since the last write wins in
// buildEnv, the general rule "the command line overrides the config file" also
// holds for this slice flag.
func TestSessionEnvRepeatableAndConfigMerge(t *testing.T) {
	path := write(t, "session-env = A=from-file\nsession-env = B=from-file\n")

	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	var list envList
	fs.Var(&list, "session-env", "")

	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse([]string{"--session-env", "A=from-cli"}); err != nil {
		t.Fatal(err)
	}

	want := []string{"A=from-file", "B=from-file", "A=from-cli"}
	if len(list) != len(want) {
		t.Fatalf("session-env = %v, want %v", list, want)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Fatalf("session-env[%d] = %q, want %q (order decides which wins)", i, list[i], want[i])
		}
	}
}

// A bad --session-env in the config file must also fail at startup, not be
// accepted silently.
func TestSessionEnvBadValueInConfigFile(t *testing.T) {
	path := write(t, "session-env = TERM=dumb\n")
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	var list envList
	fs.Var(&list, "session-env", "")

	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("TERM=dumb in the config file should be rejected")
	}
	if !strings.Contains(err.Error(), "TERM") {
		t.Fatalf("error = %q, want it to name TERM", err.Error())
	}
}
