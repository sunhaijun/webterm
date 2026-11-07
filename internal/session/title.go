package session

import (
	"strings"
	"unicode"
)

// Terminal title as automatic session name (ADR-0043).
//
// A title belongs to the process group that was in the foreground when it was
// set: when polling sees the write count change, the title is attributed to
// the current foreground process group. It is used only while that group is
// still in the foreground and is not the shell itself. So the shell's
// `user@host: dir` prompt title (Debian's default .bashrc) is ignored, the name
// falls back to the directory when the program exits, and a newly started
// program doesn't inherit the previous title before setting its own.

// maxTitleRunes caps the title length. A 240px tab or a drawer row shows only
// 20-30 characters; anything longer just bloats messages.
const maxTitleRunes = 64

// cleanTitle sanitizes a program-set title: control characters (C0, DEL, C1)
// become spaces, whitespace runs collapse to one, leading and trailing
// whitespace is trimmed, and the result is capped at maxTitleRunes. The
// content is not otherwise rewritten; claude's ✳ / ◐ prefix is its busy/idle
// signal.
func cleanTitle(raw string) string {
	var b strings.Builder
	space := false
	n := 0
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			space = b.Len() > 0
			continue
		}
		if n == maxTitleRunes {
			break
		}
		if space {
			if n+1 == maxTitleRunes {
				break
			}
			b.WriteByte(' ')
			n++
			space = false
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// busyTitle reports whether a title says the program is working: its first
// rune is a spinner frame, braille U+2801–U+28FF or ◐ ◓ ◑ ◒ (ADR-0052 §1).
// claude shows ◐ / ◑ while it works and ✳ when idle; codex's spinner is
// braille. U+2800 is a blank cell, not a frame.
func busyTitle(title string) bool {
	for _, r := range title {
		return (r >= 0x2801 && r <= 0x28FF) || r == '◐' || r == '◓' || r == '◑' || r == '◒'
	}
	return false
}

// pickTitle decides which title to use ("" = none, the name falls back to the
// directory). fg is the current foreground process group, owner is the
// title's owning group, and shell is the shell's pid (an interactive shell
// with job control leads its own group, so pid == pgid; 0 = unknown).
func pickTitle(raw string, fg, owner, shell int) string {
	if owner <= 0 || fg != owner || (shell > 0 && fg == shell) {
		return ""
	}
	return cleanTitle(raw)
}
