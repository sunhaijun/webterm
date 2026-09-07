package agent

import (
	"errors"
	"strings"
	"testing"
)

// 证书申请失败时给「原因 + 怎么修」，而不是甩一行 Go 的 error（US-7.2 / AC-1.13）。
func TestDescribeACMEError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want []string
	}{
		{
			"挑战打不进来 → 先查安全组",
			errors.New(`acme: authorization error for term.example.com: Invalid response from http://...`),
			// 云安全组是最常漏的一步，必须排在第一条
			[]string{"安全组", "curl -sI http://term.example.com/", "dig +short", "Cloudflare"},
		},
		{
			"限流 → 说清窗口有多长",
			errors.New("urn:ietf:params:acme:error:rateLimited: too many certificates"),
			[]string{"限流", "一周", "--acme-staging"},
		},
		{
			"域名解析不出来",
			errors.New(`dial tcp: lookup term.example.com: no such host`),
			[]string{"解析不出来", "dig +short"},
		},
		{
			"域名与 --domain 不一致",
			errors.New(`acme/autocert: host "evil.com" not configured in HostWhitelist`),
			[]string{"不一致", "不允许通配"},
		},
		{
			"认不出来的错也要给排障入口",
			errors.New("something entirely unexpected"),
			[]string{"something entirely unexpected", "troubleshooting.md"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := describeACMEError(tc.err, "term.example.com", false)
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("诊断里没有 %q：\n%s", want, got)
				}
			}
			// 不该把裸的 Go error 甩给用户当主要内容
			if strings.HasPrefix(strings.TrimSpace(got), "acme:") {
				t.Errorf("诊断以裸 error 开头：\n%s", got)
			}
		})
	}
}

// 已经在用 staging 时不该再劝人用 staging。
func TestDescribeACMEErrorStagingHint(t *testing.T) {
	err := errors.New("rateLimited")
	if strings.Contains(describeACMEError(err, "x.example.com", true), "先用 --acme-staging 调通") {
		t.Error("已经在 staging 了还劝人用 staging")
	}
	if !strings.Contains(describeACMEError(err, "x.example.com", false), "--acme-staging") {
		t.Error("正式环境失败时应当提示先用 staging")
	}
}
