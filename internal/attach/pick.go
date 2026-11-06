// Package attach is the client side of `webterm attach` (ADR-0050): it joins
// one of the agent's sessions from the terminal it runs in, usually one that
// came in through sshd.
package attach

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// Entry is one session in display order, numbered from 1 like the tab bar's
// [n] (ADR-0040).
type Entry struct {
	N    int
	Info protocol.SessionInfo
	Self bool // the session this command runs in; never picked
}

// Choice is what Pick decided.
type Choice struct {
	SID    uint16  // attach to this session (when New is false and Prompt is nil)
	New    bool    // create a session
	Prompt []Entry // ask the user to choose among these (or n for a new one)
}

// PickError is a choice that can't be made, with the list to show under it.
type PickError struct {
	Msg  string
	List []Entry
}

func (e *PickError) Error() string { return e.Msg }

// Entries numbers the sessions and marks the one with sid self (0 = none).
func Entries(sessions []protocol.SessionInfo, self uint16) []Entry {
	out := make([]Entry, len(sessions))
	for i, s := range sessions {
		out[i] = Entry{N: i + 1, Info: s, Self: self != 0 && s.SID == self}
	}
	return out
}

// Pick chooses a session for target (ADR-0050 §4):
//
//	""        none → new; exactly one (not this one) → it; otherwise ask
//	a number  the session at that position
//	a name    an exact match, else a case-insensitive substring; several → ask
func Pick(entries []Entry, target string) (Choice, error) {
	if target == "" {
		switch {
		case len(entries) == 0:
			return Choice{New: true}, nil
		case len(entries) == 1 && !entries[0].Self:
			return Choice{SID: entries[0].Info.SID}, nil
		default:
			return Choice{Prompt: entries}, nil
		}
	}
	if n, err := strconv.Atoi(target); err == nil {
		if n < 1 || n > len(entries) {
			return Choice{}, &PickError{Msg: fmt.Sprintf("no session %d", n), List: entries}
		}
		return one(entries[n-1], entries)
	}
	var exact, sub []Entry
	low := strings.ToLower(target)
	for _, e := range entries {
		if e.Info.Name == target {
			exact = append(exact, e)
		}
		if strings.Contains(strings.ToLower(e.Info.Name), low) {
			sub = append(sub, e)
		}
	}
	for _, m := range [][]Entry{exact, sub} {
		switch len(m) {
		case 0:
			continue
		case 1:
			return one(m[0], entries)
		default:
			return Choice{Prompt: m}, nil
		}
	}
	return Choice{}, &PickError{Msg: fmt.Sprintf("no session matches %q", target), List: entries}
}

func one(e Entry, all []Entry) (Choice, error) {
	if e.Self {
		return Choice{}, &PickError{Msg: "that is the session this command runs in", List: all}
	}
	return Choice{SID: e.Info.SID}, nil
}

// FormatList renders entries one per line: `N  name  cwd`, then `exited` and
// `(this session)` where they apply.
func FormatList(entries []Entry, home string) string {
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "%3d  %s  %s", e.N, e.Info.Name, ShortCWD(e.Info.CWD, home))
		if e.Info.Status == protocol.StatusExited {
			b.WriteString("  exited")
		}
		if e.Self {
			b.WriteString("  (this session)")
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// ShortCWD abbreviates home and everything under it to ~, like the browser
// (protocol §4.2 welcome.home).
func ShortCWD(cwd, home string) string {
	h := strings.TrimSuffix(home, "/")
	if h == "" {
		return cwd
	}
	if cwd == h {
		return "~"
	}
	if strings.HasPrefix(cwd, h+"/") {
		return "~" + cwd[len(h):]
	}
	return cwd
}

// PromptText is the question under a list: the numbers that can be picked and
// n for a new session.
func PromptText(entries []Entry) string {
	var nums []int
	for _, e := range entries {
		if !e.Self {
			nums = append(nums, e.N)
		}
	}
	var r string
	switch {
	case len(nums) == 0:
		r = ""
	case nums[len(nums)-1]-nums[0] == len(nums)-1 && len(nums) > 1:
		r = fmt.Sprintf("%d-%d, ", nums[0], nums[len(nums)-1])
	default:
		parts := make([]string, len(nums))
		for i, n := range nums {
			parts[i] = strconv.Itoa(n)
		}
		r = strings.Join(parts, ", ") + ", "
	}
	return "Session [" + r + "n = new]: "
}

// Answer interprets a line typed at the prompt: a listed number, n for new,
// or q to give up. ok is false for anything else, and the prompt repeats.
func Answer(entries []Entry, line string) (c Choice, quit, ok bool) {
	line = strings.TrimSpace(line)
	switch strings.ToLower(line) {
	case "n":
		return Choice{New: true}, false, true
	case "q":
		return Choice{}, true, true
	}
	n, err := strconv.Atoi(line)
	if err != nil {
		return Choice{}, false, false
	}
	for _, e := range entries {
		if e.N == n && !e.Self {
			return Choice{SID: e.Info.SID}, false, true
		}
	}
	return Choice{}, false, false
}
