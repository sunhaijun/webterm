package attach

import (
	"errors"
	"testing"

	"github.com/sunhaijun/webterm/internal/protocol"
)

func infos(names ...string) []protocol.SessionInfo {
	out := make([]protocol.SessionInfo, len(names))
	for i, n := range names {
		out[i] = protocol.SessionInfo{SID: uint16(10 + i), Name: n, CWD: "/home/u", Status: protocol.StatusRunning}
	}
	return out
}

// UT-attach-pick (AC-1.23, ADR-0050 §4).
func TestPick(t *testing.T) {
	three := Entries(infos("webterm", "✳ Claude Code", "build"), 0)

	cases := []struct {
		name    string
		entries []Entry
		target  string
		sid     uint16
		isNew   bool
		prompt  []int // N of the entries to ask about
		err     string
	}{
		{"none → new", Entries(nil, 0), "", 0, true, nil, ""},
		{"one → it", Entries(infos("a"), 0), "", 10, false, nil, ""},
		{"one that is self → ask", Entries(infos("a"), 10), "", 0, false, []int{1}, ""},
		{"several → ask", three, "", 0, false, []int{1, 2, 3}, ""},
		{"number", three, "2", 11, false, nil, ""},
		{"number out of range", three, "4", 0, false, nil, "no session 4"},
		{"number zero", three, "0", 0, false, nil, "no session 0"},
		{"exact name", three, "build", 12, false, nil, ""},
		{"substring, case-insensitive", three, "claude", 11, false, nil, ""},
		{"no match", three, "nope", 0, false, nil, `no session matches "nope"`},
		{"self by number", Entries(infos("a", "b"), 11), "2", 0, false, nil, "that is the session this command runs in"},
		{"self by name", Entries(infos("a", "b"), 11), "b", 0, false, nil, "that is the session this command runs in"},
		{"several substrings → narrowed", Entries(infos("api", "web", "api-test"), 0), "AP", 0, false, []int{1, 3}, ""},
		{"exact wins over substrings", Entries(infos("api", "web", "api-test"), 0), "api", 10, false, nil, ""},
		{"duplicate exact names → ask among them", Entries(infos("webterm", "x", "webterm"), 0), "webterm", 0, false, []int{1, 3}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Pick(c.entries, c.target)
			if c.err != "" {
				var pe *PickError
				if !errors.As(err, &pe) || pe.Msg != c.err {
					t.Fatalf("err = %v, want %q", err, c.err)
				}
				if len(pe.List) != len(c.entries) {
					t.Fatalf("error lists %d sessions, want all %d", len(pe.List), len(c.entries))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.New != c.isNew || (c.prompt == nil && got.SID != c.sid) {
				t.Fatalf("got %+v, want sid %d new %v", got, c.sid, c.isNew)
			}
			var ns []int
			for _, e := range got.Prompt {
				ns = append(ns, e.N)
			}
			if len(ns) != len(c.prompt) {
				t.Fatalf("prompt %v, want %v", ns, c.prompt)
			}
			for i := range ns {
				if ns[i] != c.prompt[i] {
					t.Fatalf("prompt %v, want %v", ns, c.prompt)
				}
			}
		})
	}
}

func TestFormatList(t *testing.T) {
	ss := infos("webterm", "build", "here")
	ss[0].CWD = "/home/u/github/webterm"
	ss[1].CWD = "/srv/app"
	ss[1].Status = protocol.StatusExited
	ss[2].CWD = "/home/u"
	got := FormatList(Entries(ss, 12), "/home/u/")
	want := "  1  webterm  ~/github/webterm\n" +
		"  2  build  /srv/app  exited\n" +
		"  3  here  ~  (this session)\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if ShortCWD("/home/user2", "/home/u") != "/home/user2" {
		t.Fatal("a sibling of home must not be shortened")
	}
	if ShortCWD("/x", "") != "/x" {
		t.Fatal("no home: nothing shortened")
	}
}

func TestPromptAndAnswer(t *testing.T) {
	all := Entries(infos("a", "b", "c"), 0)
	if got := PromptText(all); got != "Session [1-3, n = new]: " {
		t.Fatalf("prompt %q", got)
	}
	narrowed := []Entry{all[0], all[2]}
	if got := PromptText(narrowed); got != "Session [1, 3, n = new]: " {
		t.Fatalf("narrowed prompt %q", got)
	}
	selfOnly := Entries(infos("a"), 10)
	if got := PromptText(selfOnly); got != "Session [n = new]: " {
		t.Fatalf("self-only prompt %q", got)
	}

	if c, q, ok := Answer(narrowed, " 3\n"); !ok || q || c.SID != 12 {
		t.Fatalf("answer 3: %+v %v %v", c, q, ok)
	}
	if _, _, ok := Answer(narrowed, "2"); ok {
		t.Fatal("2 is not in the narrowed list")
	}
	if c, _, ok := Answer(narrowed, "N"); !ok || !c.New {
		t.Fatal("n means new")
	}
	if _, q, ok := Answer(narrowed, "q"); !ok || !q {
		t.Fatal("q quits")
	}
	if _, _, ok := Answer(selfOnly, "1"); ok {
		t.Fatal("this session can't be picked")
	}
	if _, _, ok := Answer(all, "x"); ok {
		t.Fatal("garbage is not an answer")
	}
}
