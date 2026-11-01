package session

import "testing"

// Session environment precedence (AC-7.8):
//
//	fixed > --session-env > inherited environment > built-in compat list
//
// Each step of this order prevents a specific failure; see the case names.
func TestBuildEnvPrecedence(t *testing.T) {
	compat := []string{"COMPAT=1"}
	fixed := []string{"TERM=xterm-256color", "WEBTERM_SESSION=7"}

	cases := []struct {
		name       string
		base       []string
		sessionEnv []string
		key, want  string
	}{
		{
			"not inherited: compat list applies",
			nil, nil, "COMPAT", "1",
		},
		{
			"already in the user's environment: compat list does not override (their machine)",
			[]string{"COMPAT=0"}, nil, "COMPAT", "0",
		},
		{
			"--session-env overrides the compat list",
			nil, []string{"COMPAT=0"}, "COMPAT", "0",
		},
		{
			"--session-env overrides inherited env (explicit intent beats incidental inheritance)",
			[]string{"FOO=inherited"}, []string{"FOO=explicit"}, "FOO", "explicit",
		},
		{
			"repeated key: last wins (config file loads before command line parse)",
			nil, []string{"FOO=first", "FOO=second"}, "FOO", "second",
		},
		{
			"TERM is fixed by webterm, even against --session-env (flags reject it first; this is the second guard)",
			[]string{"TERM=screen"}, []string{"TERM=dumb"}, "TERM", "xterm-256color",
		},
		{
			"inherited env is kept as is",
			[]string{"PATH=/usr/bin"}, nil, "PATH", "/usr/bin",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildEnv(tc.base, compat, tc.sessionEnv, fixed)
			v, ok := lookupEnv(got, tc.key)
			if !ok || v != tc.want {
				t.Fatalf("%s = %q (present=%v), want %q\nenv: %v", tc.key, v, ok, tc.want, got)
			}
		})
	}
}

// Each key appears once. exec deduplicates too (last wins), but that rule is
// implicit, and relying on it leaves whoever swaps the implementation
// wondering why a key is set twice.
func TestBuildEnvDedup(t *testing.T) {
	got := buildEnv(
		[]string{"A=1", "A=2", "B=1"},
		[]string{"A=3"},
		[]string{"B=2"},
		nil,
	)
	if n := countKey(got, "A"); n != 1 {
		t.Fatalf("A appears %d times, want once: %v", n, got)
	}
	if v, _ := lookupEnv(got, "A"); v != "2" {
		t.Fatalf("A = %q, want 2 (last in base wins; compat does not override existing keys)", v)
	}
	if v, _ := lookupEnv(got, "B"); v != "2" {
		t.Fatalf("B = %q, want 2", v)
	}
}

// Entries without '=' have no key and are dropped; in exec.Cmd.Env they would
// only be junk nobody can read.
func TestBuildEnvDropsMalformed(t *testing.T) {
	got := buildEnv([]string{"GOOD=1", "NOEQUALS", "=novalue"}, nil, nil, nil)
	if len(got) != 1 || got[0] != "GOOD=1" {
		t.Fatalf("env = %v, want [GOOD=1]", got)
	}
}

// --no-altscreen-compat disables the whole list; the zero Config must keep it
// enabled.
func TestCompatEnvToggle(t *testing.T) {
	var on Config
	if len(on.compatEnv()) == 0 {
		t.Fatal("zero Config should include the compat list; that is why the on-by-default switch is a negated field")
	}
	off := Config{NoAltScreenCompat: true}
	if got := off.compatEnv(); got != nil {
		t.Fatalf("%v left after --no-altscreen-compat", got)
	}
}

// The list itself holds only switches that move a TUI back to the main screen,
// each a valid KEY=VAL.
func TestAltScreenCompatShape(t *testing.T) {
	if len(altScreenCompat) == 0 {
		t.Fatal("compat list is empty, which makes --no-altscreen-compat meaningless")
	}
	for _, kv := range altScreenCompat {
		if envKey(kv) == "" {
			t.Fatalf("compat entry %q is not KEY=VAL", kv)
		}
	}
}

func lookupEnv(env []string, key string) (string, bool) {
	for _, kv := range env {
		if envKey(kv) == key {
			return kv[len(key)+1:], true
		}
	}
	return "", false
}

func countKey(env []string, key string) int {
	n := 0
	for _, kv := range env {
		if envKey(kv) == key {
			n++
		}
	}
	return n
}
