package main

import (
	"os/exec"
	"strings"
)

// unitKind is the systemd unit installed on this machine. Since ADR-0034,
// install.sh installs a system service that runs as the installing user;
// older machines still have a user service until they migrate, so both occur.
type unitKind int

const (
	unitNone unitKind = iota
	unitSystem
	unitUser
)

// detectUnit asks systemd whether a webterm unit exists. Reading LoadState
// needs no sudo. The system unit wins: midway through a migration both may
// exist, and the system unit is the one that matters.
func detectUnit() unitKind {
	if unitLoaded("systemctl", "show", "webterm", "-p", "LoadState", "--value") {
		return unitSystem
	}
	if unitLoaded("systemctl", "--user", "show", "webterm", "-p", "LoadState", "--value") {
		return unitUser
	}
	return unitNone
}

func unitLoaded(name string, args ...string) bool {
	out, err := exec.Command(name, args...).Output()
	return err == nil && strings.TrimSpace(string(out)) == "loaded"
}

// active reports whether the unit is active.
func (k unitKind) active() bool {
	var args []string
	switch k {
	case unitSystem:
		args = []string{"is-active", "--quiet", "webterm"}
	case unitUser:
		args = []string{"--user", "is-active", "--quiet", "webterm"}
	default:
		return false
	}
	return exec.Command("systemctl", args...).Run() == nil
}

// ctl returns the systemctl command to show in hints. Starting or stopping a
// system service needs sudo; read-only verbs do not.
func (k unitKind) ctl(verb string) string {
	switch k {
	case unitUser:
		return "systemctl --user " + verb + " webterm"
	default:
		switch verb {
		case "status", "show", "is-active", "cat":
			return "systemctl " + verb + " webterm"
		}
		return "sudo systemctl " + verb + " webterm"
	}
}

// journal returns the command for reading logs. Under a system service the
// agent's own logs are readable without sudo, but systemd's records about the
// unit (start/stop, OOM kills, crashes) are in the system journal, which needs
// sudo when troubleshooting.
func (k unitKind) journal() string {
	if k == unitUser {
		return "journalctl --user -u webterm"
	}
	return "sudo journalctl -u webterm"
}
