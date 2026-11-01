package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/sunhaijun/webterm/scripts"
)

// runInstall runs the install.sh embedded in this binary, with the binary itself as
// --binary (ADR-0045 §1). Go only extracts and runs the script: the installation
// logic lives in one place, install.sh.
func runInstall(args []string) error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("can't find this executable: %w", err)
	}
	if p, err := filepath.EvalSymlinks(self); err == nil {
		self = p
	}

	f, err := os.CreateTemp("", "webterm-install-*.sh")
	if err != nil {
		return err
	}
	script := f.Name()
	defer os.Remove(script)
	if _, err := f.Write(scripts.InstallSH); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	// Pass the terminal through: sudo and the guided steps ask questions.
	cmd := exec.Command("bash", append([]string{script}, withSelfBinary(self, args)...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// The script has already explained the failure; just propagate its exit code.
		return exitCode(ee.ExitCode())
	}
	return err
}

// withSelfBinary prepends --binary <self> unless the user passed --binary.
func withSelfBinary(self string, args []string) []string {
	for _, a := range args {
		if a == "--binary" || strings.HasPrefix(a, "--binary=") {
			return args
		}
	}
	return append([]string{"--binary", self}, args...)
}

// exitCode means a child already reported the error; exit with this code silently.
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
