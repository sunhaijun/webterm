package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// update upgrades to the latest release with one command.
//
// It is deliberately a thin wrapper: it fetches the latest install.sh and
// reruns it with the flags of the last successful install, instead of
// reimplementing download, verification, setcap and restart in Go.
//
// Nearly everything about the upgrade path lives in install.sh, and most of it
// was learned the hard way: private repos need credential fallbacks, artifacts
// must match their SHA256, replacing the binary drops its file capability so
// setcap must be redone and verified, and the systemd unit has to follow the
// ports. A second copy here would drift, and drift is what caused those bugs.
//
// It also keeps the semantics easy to explain: redo the last successful
// install with the new release.

// installStateName is the file where install.sh records the install flags.
//
// One argument per line, exactly as written on the command line. Not
// key=value: update would then need to map keys back to flags, one more
// mapping that could drift. Replaying verbatim needs no interpretation.
const installStateName = "install-state"

func installStatePath() string {
	dir := defaultConfigPath()
	if dir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(dir), installStateName)
}

func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", false, "print the command that would run, without upgrading")
	statePath := fs.String("state", installStatePath(), "install flags file")
	// --script uses a local install.sh instead of downloading one: for offline
	// deployments, self-hosted mirrors, and testing changes from a source tree.
	local := fs.String("script", "", "use a local install.sh (default: fetch the latest from the repository)")
	// Two one-off switches (ADR-0016); neither is recorded in install-state.
	whenIdle := fs.Bool("when-idle", false, "wait until every session is idle at a prompt before upgrading")
	forceRestart := fs.Bool("force-restart", false, "skip the hot upgrade and use systemctl restart (closes all sessions); also migrates a user service to a system service (ADR-0034)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	installArgs, err := readInstallState(*statePath)
	if err != nil {
		return err
	}

	fmt.Printf("webterm %s\n\n", version)
	fmt.Println("  Upgrading with the flags from the last install:")
	fmt.Printf("    %s\n\n", strings.Join(installArgs, " "))

	scriptPath := *local
	if scriptPath == "" {
		script, src, err := fetchInstallScript()
		if err != nil {
			return err
		}
		fmt.Printf("  Install script: %s\n\n", src)

		tmp, err := os.CreateTemp("", "webterm-install-*.sh")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		if _, err := tmp.Write(script); err != nil {
			tmp.Close()
			return err
		}
		tmp.Close()
		scriptPath = tmp.Name()
	} else {
		fmt.Printf("  Install script: %s (--script)\n\n", scriptPath)
	}

	// --if-newer makes install.sh do nothing when the version is unchanged.
	// Reinstalling unconditionally would restart the service and drop the
	// sessions in use.
	full := append([]string{scriptPath}, append(installArgs, "--if-newer")...)
	if *whenIdle {
		full = append(full, "--when-idle")
	}
	if *forceRestart {
		full = append(full, "--force-restart")
	}
	if *dryRun {
		fmt.Printf("  $ bash %s\n", strings.Join(full, " "))
		return nil
	}

	cmd := exec.Command("bash", full...)
	// Attach to the terminal so sudo inside install.sh can prompt for a password.
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// readInstallState reads back the last install's flags, skipping blank lines
// and comments.
func readInstallState(path string) ([]string, error) {
	if path == "" {
		return nil, errors.New("cannot locate the config directory; pass the install flags file with --state")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s not found: this machine has not been installed with install.sh,\n"+
				"or the installer was too old to record install flags. Install once normally;\n"+
				"update works after that. See docs/80-ops/install.md", path)
		}
		return nil, err
	}
	var args []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		args = append(args, line)
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("%s contains no arguments", path)
	}
	return args, nil
}

// fetchInstallScript downloads the latest install.sh.
//
// It falls back in the same order install.sh uses to fetch the binary:
// anonymous first (always a 404 for a private repo), then gh, then a token.
func fetchInstallScript() ([]byte, string, error) {
	repo := os.Getenv("WEBTERM_REPO")
	if repo == "" {
		repo = "sunhaijun/webterm"
	}

	raw := fmt.Sprintf("https://raw.githubusercontent.com/%s/main/scripts/install.sh", repo)
	if b, err := httpGet(raw, ""); err == nil {
		return b, raw, nil
	}

	if _, err := exec.LookPath("gh"); err == nil {
		out, err := exec.Command("gh", "api",
			fmt.Sprintf("repos/%s/contents/scripts/install.sh", repo),
			"-H", "Accept: application/vnd.github.raw").Output()
		if err == nil && len(out) > 0 {
			return out, "gh api (private repository credentials)", nil
		}
	}

	api := fmt.Sprintf("https://api.github.com/repos/%s/contents/scripts/install.sh", repo)
	for _, env := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if tok := os.Getenv(env); tok != "" {
			if b, err := httpGet(api, tok); err == nil {
				return b, api + " (" + env + ")", nil
			}
		}
	}

	return nil, "", fmt.Errorf("cannot fetch install.sh. A private repository needs credentials:\n"+
		"  gh auth login    (recommended)\n"+
		"  export GH_TOKEN=<token with repo read access>\n"+
		"Tried: %s", raw)
}

func httpGet(url, token string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/vnd.github.raw")
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	// A script is never megabytes; cap the read so an unexpected large response
	// does not end up in memory.
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(b), "#!") {
		return nil, fmt.Errorf("%s did not return a script", url)
	}
	return b, nil
}
