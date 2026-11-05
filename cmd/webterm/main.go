// Command webterm is the agent. One binary is the whole service: it embeds the
// frontend, terminates TLS, authenticates devices and owns the sessions
// (ADR-0002).
package main

import (
	"errors"
	"fmt"
	"os"
)

// version is set at build time:
//
//	go build -ldflags "-X main.version=v0.1.0"
//
// The default only appears in binaries built straight from source.
var version = "dev"

var usage = "webterm " + version + ` - browser terminal agent

Usage:
  webterm install [flags]         Install this binary as a system service (uses the public IP without --domain)
  webterm serve [flags]           Run the server
  webterm pair                    Create a pairing code (prints a URL and QR code)
  webterm devices [command]       Manage devices: list | revoke <id> | revoke-all
  webterm doctor [--acme]         Check deployment prerequisites; --acme also obtains the certificate
  webterm update                  Upgrade to the latest release using the last install's flags (hot upgrade; sessions survive)
  webterm reload [--when-idle]    Swap the running agent for the binary on disk; sessions survive
  webterm version                 Print the version

Run webterm with no command for a status overview (service, URL, certificate, devices).

Run "webterm serve --help" for all serve flags.
`

func main() {
	// With no arguments, show the status overview rather than usage: the
	// everyday question is "is it working?". Usage is behind --help.
	if len(os.Args) < 2 {
		if err := runStatus(); err != nil {
			fmt.Fprintf(os.Stderr, "\nerror: %v\n", err)
			os.Exit(1)
		}
		return
	}
	var err error
	switch os.Args[1] {
	case "install":
		err = runInstall(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "pair":
		err = runPair(os.Args[2:])
	case "devices":
		err = runDevices(os.Args[2:])
	case "doctor":
		err = runDoctor(os.Args[2:])
	case "update":
		err = runUpdate(os.Args[2:])
	case "reload":
		err = runReload(os.Args[2:])
	case "handoff-check":
		err = runHandoffCheck(os.Args[2:])
	case "version":
		fmt.Printf("webterm %s\n", version)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	var code exitCode
	if errors.As(err, &code) {
		os.Exit(int(code))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\nerror: %v\n", err)
		os.Exit(1)
	}
}
