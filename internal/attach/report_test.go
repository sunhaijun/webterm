package attach

import "testing"

// UT-attach-report (AC-4.14, ADR-0050 §5): which stdin reads are the local
// terminal answering a query (never a size claim) and which are the user.
func TestIsReport(t *testing.T) {
	reports := map[string]string{
		"CPR":                  "\x1b[12;40R",
		"DECXCPR":              "\x1b[?12;40;1R",
		"DA1":                  "\x1b[?62;22c",
		"DA2":                  "\x1b[>1;10;0c",
		"DA3":                  "\x1bP!|00000000\x1b\\",
		"DECRPM":               "\x1b[?2026;2$y",
		"ANSI DECRPM":          "\x1b[4;2$y",
		"focus in":             "\x1b[I",
		"focus out":            "\x1b[O",
		"kitty flags":          "\x1b[?1u",
		"window size report":   "\x1b[8;24;80t",
		"pixel size report":    "\x1b[4;480;640t",
		"device status":        "\x1b[0n",
		"OSC 11 BEL":           "\x1b]11;rgb:0000/0000/0000\x07",
		"OSC 10 ST":            "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
		"OSC 4 color":          "\x1b]4;1;rgb:cdcd/0000/0000\x1b\\",
		"XTVERSION":            "\x1bP>|xterm(390)\x1b\\",
		"DECRQSS":              "\x1bP1$r0;1m\x1b\\",
		"XTGETTCAP":            "\x1bP1+r544e=787465726d\x1b\\",
		"several in one read":  "\x1b[?62;22c\x1b[12;40R\x1b]11;rgb:0/0/0\x07",
		"APC (kitty graphics)": "\x1b_Gi=1;OK\x1b\\",
		"focus then CPR":       "\x1b[I\x1b[1;1R",
		"report then nothing":  "\x1b[?1u",
		"DECREPTPARM":          "\x1b[2;1;1;112;112;1;0x",
	}
	for name, s := range reports {
		if !IsReport([]byte(s)) {
			t.Errorf("%s (%q) should be a report", name, s)
		}
	}

	user := map[string]string{
		"letter":                   "a",
		"text":                     "ls -la\r",
		"enter":                    "\r",
		"ctrl-c":                   "\x03",
		"lone esc":                 "\x1b",
		"alt-x":                    "\x1bx",
		"alt-[ then nothing":       "\x1b[",
		"arrow":                    "\x1b[A",
		"arrow, app mode":          "\x1bOA",
		"F1":                       "\x1bOP",
		"F5":                       "\x1b[15~",
		"ctrl-arrow":               "\x1b[1;5C",
		"shift-tab":                "\x1b[Z",
		"kitty key event":          "\x1b[97;5u",
		"SGR mouse press":          "\x1b[<0;10;5M",
		"SGR mouse release":        "\x1b[<0;10;5m",
		"SGR wheel":                "\x1b[<64;10;5M",
		"X10 mouse":                "\x1b[M !!",
		"bracketed paste":          "\x1b[200~hello\x1b[201~",
		"report followed by a key": "\x1b[12;40Ra",
		"key followed by a report": "x\x1b[12;40R",
		"utf-8":                    "日本",
		"empty":                    "",
	}
	for name, s := range user {
		if IsReport([]byte(s)) {
			t.Errorf("%s (%q) should be user input", name, s)
		}
	}
}
