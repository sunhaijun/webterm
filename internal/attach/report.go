package attach

import "bytes"

// IsReport reports whether a read from stdin is nothing but the local
// terminal answering queries: cursor position, device attributes, mode
// reports, focus in/out, kitty keyboard flags, window reports, and OSC / DCS /
// APC replies. Such reads must not claim the session's size (ADR-0050 §5):
// every attached terminal answers the same live queries, so letting answers
// claim would bounce the size between clients.
//
// Anything else, including a read that mixes a report with a key, counts as
// the user. Only 7-bit sequences are recognized: in UTF-8, the C1 bytes are
// continuation bytes of ordinary characters.
func IsReport(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for len(b) > 0 {
		n, report := token(b)
		if !report {
			return false
		}
		b = b[n:]
	}
	return true
}

// token measures the sequence at the start of b and says whether it is a
// report.
func token(b []byte) (int, bool) {
	if b[0] != 0x1b || len(b) < 2 {
		return 1, false
	}
	switch b[1] {
	case '[':
		i := 2
		for i < len(b) && b[i] >= 0x30 && b[i] <= 0x3f { // parameter bytes
			i++
		}
		j := i
		for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f { // intermediate bytes
			j++
		}
		if j >= len(b) || b[j] < 0x40 || b[j] > 0x7e {
			return len(b), false // incomplete: a key typed as Alt+[
		}
		return j + 1, csiReport(b[2:i], b[i:j], b[j])
	case ']', 'P', '_': // OSC, DCS, APC: up to ST (or BEL for OSC)
		for i := 2; i < len(b); i++ {
			if b[i] == 0x07 && b[1] == ']' {
				return i + 1, true
			}
			if b[i] == 0x1b && i+1 < len(b) && b[i+1] == '\\' {
				return i + 2, true
			}
		}
		return len(b), false
	}
	return 2, false // SS3 keys (ESC O x), Alt+key
}

func csiReport(params, inter []byte, final byte) bool {
	switch final {
	case 'R': // CPR, DECXCPR. Shift+F3 in xterm's old encoding looks the same; it just won't claim.
		return true
	case 'c': // DA1 / DA2 / DA3 replies; keys never send CSI c
		return true
	case 'y': // DECRPM: CSI ? n ; m $ y
		return bytes.Equal(inter, []byte("$"))
	case 'I', 'O': // focus in / out
		return len(params) == 0 && len(inter) == 0
	case 'u': // kitty keyboard flags reply; key events carry no '?'
		return len(params) > 0 && params[0] == '?'
	case 't', 'n', 'x': // window reports, device status, DECREPTPARM
		return true
	}
	return false
}
