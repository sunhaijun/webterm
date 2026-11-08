package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The config file spares pair, doctor and devices from repeating --domain and
// --https-port on every run.
//
// Keys are flag names without the leading "--". There is deliberately no
// TOML/YAML: that would add a dependency for a dozen flat keys. Sharing names
// with the flags means the two cannot drift: `webterm serve --help` documents
// the file, and tests pin the mapping (TestConfigKeysAllExistOnServe /
// TestServeFlagsAreConfigurable).

// configKeys is the set of keys allowed in the config file.
//
// It is an explicit allowlist rather than "any flag" because one file is shared
// by every subcommand: keys that belong to another subcommand must be skipped
// silently (devices has no --https-port), while misspelled keys must fail. Only
// an explicit list can tell the two apart.
//
// dev and config are deliberately excluded. --dev is a switch for quick local
// runs, and putting it in the file would permanently downgrade production;
// --config would refer to itself.
var configKeys = map[string]bool{
	"domain":              true,
	"data-dir":            true,
	"bind":                true,
	"http-port":           true,
	"https-port":          true,
	"no-tls":              true,
	"trust-proxy":         true,
	"shell":               true,
	"max-sessions":        true,
	"max-conns":           true,
	"ring-bytes":          true,
	"session-env":         true,
	"no-altscreen-compat": true,
	"no-login-shell":      true,
	"log-level":           true,
}

// removedConfigKeys lists keys that no longer exist, with the reason. Using one
// still fails startup (ignoring it silently would suggest it still works), but
// the error says the key was removed and the line can go, rather than "unknown
// option", which makes people suspect a typo.
var removedConfigKeys = map[string]string{
	"acme-staging": "staging and production certificates share one cache, so it could make the production server serve a staging certificate; " +
		"first installs now obtain a production certificate directly (ADR-0044 §3)",
}

// defaultConfigPath follows XDG: $XDG_CONFIG_HOME/webterm/config, else
// ~/.config/webterm/config.
func defaultConfigPath() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "webterm", "config")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "webterm", "config")
}

// commandsFilePath is where the command strip's arrangement is kept:
// commands.json in the default config directory (ADR-0057 §5).
func commandsFilePath() string {
	p := defaultConfigPath()
	if p == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p), "commands.json")
}

// configPathFrom extracts --config from args before the real Parse.
//
// It is a chicken-and-egg problem: the file named by --config fills in the
// flags, but --config is itself a flag. Scanning argv by hand is the simplest
// fix and does not interfere with normal parsing.
func configPathFrom(args []string) string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--config" || a == "-config":
			if i+1 < len(args) {
				return args[i+1]
			}
		case strings.HasPrefix(a, "--config="):
			return strings.TrimPrefix(a, "--config=")
		case strings.HasPrefix(a, "-config="):
			return strings.TrimPrefix(a, "-config=")
		}
	}
	return defaultConfigPath()
}

// loadConfigInto sets the flags in fs from the config file at path.
//
// It must run before fs.Parse(args). It only changes the flags' current
// values, so the Parse that follows lets the command line override the file.
//
// A missing file is not an error; most users do not need one.
func loadConfigInto(fs *flag.FlagSet, path string) error {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read config file %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for line := 1; sc.Scan(); line++ {
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		key, val := text, "true" // a bare key sets a boolean to true
		if i := strings.IndexByte(text, '='); i >= 0 {
			key = strings.TrimSpace(text[:i])
			val = strings.TrimSpace(text[i+1:])
		}
		key = strings.TrimLeft(key, "-") // tolerate "--domain"

		if !configKeys[key] {
			if why, ok := removedConfigKeys[key]; ok {
				return fmt.Errorf("%s:%d: --%s has been removed: %s.\n  Delete this line", path, line, key, why)
			}
			if key == "dev" || key == "config" {
				return fmt.Errorf("%s:%d: --%s is not allowed in the config file.\n"+
					"  --dev is for quick local runs; in the file it would permanently downgrade production.\n"+
					"  --config would refer to itself. Pass either one on the command line", path, line, key)
			}
			return fmt.Errorf("%s:%d: unknown option --%s.\n"+
				"  Valid keys are the flags listed by webterm serve --help, without the leading --", path, line, key)
		}
		if fs.Lookup(key) == nil {
			continue // valid, but belongs to another subcommand
		}
		if err := fs.Set(key, val); err != nil {
			return fmt.Errorf("%s:%d: invalid value %q for --%s: %w", path, line, val, key, err)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("read config file %s: %w", path, err)
	}
	return nil
}

// registerConfigFlag adds --config to fs and returns the path to use.
func registerConfigFlag(fs *flag.FlagSet, args []string) string {
	path := configPathFrom(args)
	fs.String("config", path, "config file path")
	return path
}

// applyConfig is the standard subcommand preamble: register --config and load
// the file. The caller parses afterwards.
func applyConfig(fs *flag.FlagSet, args []string) error {
	return loadConfigInto(fs, registerConfigFlag(fs, args))
}
