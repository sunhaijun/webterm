package agent

import (
	"context"
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

// autocert 的 HostPolicy 必须严格限定为 --domain 的值。
//
// 通配的话它会被用来给【任意】域名申请证书（威胁模型 T8）——
// 别人把自己的域名解析到这台机器，就能借我们的 ACME 账号签证书。
func TestCertManagerHostPolicyIsStrict(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "term.example.com", CertDir: t.TempDir()})
	if m.HostPolicy == nil {
		t.Fatal("HostPolicy 是 nil —— 那等于允许任意域名")
	}
	ctx := context.Background()

	if err := m.HostPolicy(ctx, "term.example.com"); err != nil {
		t.Fatalf("配置的域名被拒了: %v", err)
	}
	for _, host := range []string{
		"evil.example.com",
		"example.com",
		"sub.term.example.com",
		"term.example.com.evil.com",
		"",
	} {
		if err := m.HostPolicy(ctx, host); err == nil {
			t.Errorf("HostPolicy 放过了 %q —— 它能拿我们的账号签证书", host)
		}
	}
}

// RenewBefore 刻意留空，靠 autocert 的 min(30 天, 有效期/3)。
//
// 写死 30 天的话，将来换成短周期证书（LE 已在推 6 天期的选项）就会变成
// "每次都立刻续期"，反而会撞限流。
func TestCertManagerRenewBeforeUsesLibraryDefault(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if m.RenewBefore != 0 {
		t.Fatalf("RenewBefore = %v，应当留空让库按有效期缩放（见 install.md 的「证书续期」）", m.RenewBefore)
	}
}

// --acme-staging 才走 staging 目录，默认必须是正式环境。
func TestCertManagerStagingSwitch(t *testing.T) {
	prod := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if prod.Client != nil {
		t.Error("默认不该指定 ACME 目录（用 acme 包的正式默认值）")
	}
	staging := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir(), ACMEStaging: true})
	if staging.Client == nil || !strings.Contains(staging.Client.DirectoryURL, "staging") {
		t.Errorf("--acme-staging 没有切到 staging 目录: %+v", staging.Client)
	}
}
