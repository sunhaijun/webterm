package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/setup"
)

// setupOut is where `webterm setup` writes; tests replace it.
var setupOut io.Writer = os.Stdout

// runSetup checks and adds the settings claude and codex need for "waiting
// for you" (ADR-0055, ADR-0058 §4). --check only reports (exit 1 when
// something is missing); --yes adds without asking; otherwise it asks once on
// the terminal, and adds nothing without one.
func runSetup(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	check := fs.Bool("check", false, "only report; exit 1 when something would be added")
	yes := fs.Bool("yes", false, "add what's missing without asking")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	out := setupOut
	items := setup.Plan(home)
	fmt.Fprintln(out, "webterm setup: claude and codex")
	fmt.Fprintln(out)
	pending := 0
	for _, it := range items {
		mark := map[setup.State]string{setup.OK: "✓", setup.Add: "+", setup.Kept: "·", setup.Skipped: "-", setup.Broken: "✗"}[it.State]
		file := ""
		if it.File != "" {
			file = " (" + it.File + ")"
		}
		fmt.Fprintf(out, "  %s %s%s: %s\n", mark, it.Name, file, it.Detail)
		if it.State == setup.Add {
			pending++
		}
	}
	fmt.Fprintln(out)
	if pending == 0 {
		fmt.Fprintln(out, "Nothing to add.")
		return nil
	}
	if *check {
		fmt.Fprintf(out, "%d to add: run webterm setup\n", pending)
		return exitCode(1)
	}
	if !*yes {
		tty, err := openTTY()
		if err != nil {
			fmt.Fprintln(out, "No terminal to ask on; nothing changed. To add them: webterm setup --yes")
			return nil
		}
		defer tty.Close()
		fmt.Fprint(out, "Add these? [Y/n] ")
		answer, _ := bufio.NewReader(tty).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "" && a != "y" && a != "yes" {
			fmt.Fprintln(out, "Nothing changed.")
			return nil
		}
	}
	err = setup.Apply(items, time.Now())
	for _, it := range items {
		if it.State != setup.Add {
			continue
		}
		if it.Backup != "" {
			fmt.Fprintf(out, "  added to %s (was saved as %s)\n", it.File, it.Backup)
		} else if err == nil {
			fmt.Fprintf(out, "  added to %s\n", it.File)
		}
	}
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Done. Programs already running pick this up when they restart.")
	return nil
}
