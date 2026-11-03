package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// runHandoffCheck implements handoff-check, the hot-upgrade preflight
// (ADR-0016). Before exec, the old process runs this subcommand of the new
// binary and feeds the metadata snapshot on stdin. If the new binary can decode
// it, it prints "ok schema=N" and exits 0. A failure here lets the old process
// abort the upgrade and keep serving; after exec there is no way back.
//
// args are the new process's command line ("serve", flags...). They are
// parsed along with the config file exactly as serve would, so a flag or config
// key this binary rejects fails the upgrade here rather than after exec, where
// it would crash-loop and lose every session. Agents that predate this pass no
// arguments; there is nothing to check then.
func runHandoffCheck(args []string) error {
	if _, err := handoff.Decode(os.Stdin); err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "serve" {
		if _, _, err := parseServe(args[1:], flag.ContinueOnError); err != nil {
			return fmt.Errorf("the new binary can't start with this command line or config file: %w", err)
		}
	}
	fmt.Println(handoff.CheckOutput())
	return nil
}
