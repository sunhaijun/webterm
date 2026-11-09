package scripts

import (
	"os/exec"
	"strings"
	"testing"
)

// UT-dev-prerelease (AC-8.9): which Release runs publish the rolling dev prerelease.
func TestDevPrereleaseDecision(t *testing.T) {
	const (
		head = "a01fd2221f0218fbf2ecab644a697491bae82afa"
		old  = "266cbb57f3be39ac7dab077e74ba94d1b7a562f4"
	)
	cases := []struct {
		name, ref, sha, tags, version string
		want                          string // "publish" or a prefix of the skip reason
	}{
		{"main head, untagged", "refs/heads/main", head, "", "webterm v0.7.0-9-ga01fd22", "publish"},
		{"main head, tag already there at checkout", "refs/heads/main", head, "v0.8.0", "webterm v0.8.0", "publish"},
		{"main head, tagged after checkout", "refs/heads/main", head, "v0.8.0", "webterm v0.7.0-9-ga01fd22", "skip: v0.8.0 was tagged after this build"},
		{"main moved on", "refs/heads/main", old, "", "webterm v0.7.0-8-g266cbb5", "skip: main has moved on to a01fd22"},
		{"main moved on, even if tagged", "refs/heads/main", old, "v0.7.1", "webterm v0.7.1", "skip: main has moved on"},
		{"tag on main head", "refs/tags/v0.8.0", head, "v0.8.0", "webterm v0.8.0", "publish"},
		{"tag on an older commit", "refs/tags/v0.7.1", old, "v0.7.1", "webterm v0.7.1", "skip: v0.7.1 isn't on main's head (a01fd22)"},
		{"two tags, the binary reports one", "refs/heads/main", head, "v0.8.0\nv0.8.1", "webterm v0.8.1", "skip: v0.8.0 was tagged after this build"},
		{"another branch", "refs/heads/feat/x", head, "", "webterm dev-a01fd22", "skip: refs/heads/feat/x publishes no dev"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cmd := exec.Command("bash", "dev-prerelease.sh")
			cmd.Env = []string{
				"PATH=/usr/bin:/bin",
				"REF=" + c.ref, "SHA=" + c.sha, "MAIN_HEAD=" + head,
				"TAGS=" + c.tags, "VERSION=" + c.version,
			}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("exit: %v\n%s", err, out)
			}
			got := strings.TrimSpace(string(out))
			if c.want == "publish" && got != "publish" || c.want != "publish" && !strings.HasPrefix(got, c.want) {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

// A missing input stops the script instead of deciding on an empty value.
func TestDevPrereleaseNeedsInputs(t *testing.T) {
	cmd := exec.Command("bash", "dev-prerelease.sh")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "REF=refs/heads/main", "SHA=x", "VERSION=webterm v0.8.0"}
	out, err := cmd.CombinedOutput()
	if err == nil || strings.Contains(string(out), "publish") {
		t.Fatalf("want a failure without MAIN_HEAD, got err=%v out=%q", err, out)
	}
}
