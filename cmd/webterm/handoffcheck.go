package main

import (
	"fmt"
	"os"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// runHandoffCheck implements handoff-check, the hot-upgrade preflight
// (ADR-0016). Before exec, the old process runs this subcommand of the new
// binary and feeds the metadata snapshot on stdin. If the new binary can decode
// it, it prints "ok schema=N" and exits 0. A failure here lets the old process
// abort the upgrade and keep serving; after exec there is no way back.
func runHandoffCheck() error {
	if _, err := handoff.Decode(os.Stdin); err != nil {
		return err
	}
	fmt.Println(handoff.CheckOutput())
	return nil
}
