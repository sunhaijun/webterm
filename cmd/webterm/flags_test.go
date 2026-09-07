package main

import "testing"

// baseURL 是【用户唯一能拿到的入口地址】：配对 URL 和二维码都由它拼出来。
// 漏了端口的话，443 被占时扫码打不开（docs/80-ops/install.md 的
// 「跑在非标准端口上」）。
func TestBaseURL(t *testing.T) {
	cases := []struct {
		name      string
		dev       bool
		domain    string
		httpPort  int
		httpsPort int
		want      string
	}{
		{
			"--dev 用回环加 HTTP 端口",
			true, "", 8080, 443,
			"http://127.0.0.1:8080",
		},
		{
			"--dev 换了端口也要跟着变",
			true, "", 18080, 443,
			"http://127.0.0.1:18080",
		},
		{
			"生产默认 443：不带端口（443 写出来是噪音）",
			false, "term.example.com", 80, 443,
			"https://term.example.com",
		},
		{
			// ★ 这条是本次改动的由来：443 被 Xray 占了要换端口
			"生产非 443：必须带上端口",
			false, "term.example.com", 80, 8443,
			"https://term.example.com:8443",
		},
		{
			"生产非 443：8080 这种也一样",
			false, "term.example.com", 80, 8080,
			"https://term.example.com:8080",
		},
		{
			// 0 只可能来自"调用方忘了传"，当成默认 443 而不是拼出 :0
			"httpsPort 为 0 时按 443 处理",
			false, "term.example.com", 80, 0,
			"https://term.example.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &commonFlags{domain: tc.domain, dev: tc.dev}
			if got := c.baseURL(tc.httpPort, tc.httpsPort); got != tc.want {
				t.Errorf("baseURL(%d, %d) = %q, 想要 %q", tc.httpPort, tc.httpsPort, got, tc.want)
			}
		})
	}
}

// 配对 URL 的形状：码走 fragment（AC-1.5），端口不能丢。
func TestPairURLKeepsPortAndFragment(t *testing.T) {
	c := &commonFlags{domain: "term.example.com"}
	got := c.baseURL(80, 8443) + "/pair#abc123"
	want := "https://term.example.com:8443/pair#abc123"
	if got != want {
		t.Errorf("配对 URL = %q, 想要 %q", got, want)
	}
}
