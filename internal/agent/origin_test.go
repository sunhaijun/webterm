package agent

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Origin 校验必须把【非默认端口】算进去。
//
// 真事：--https-port 8443 的部署下，手机配对成功后 /ws 一直 403 ——
// 浏览器发的是 https://域名:8443，而校验拿 https://域名 去比。
// 客户端表现成"一直在重试连接"，服务端日志一片空白。
func TestCheckOriginPort(t *testing.T) {
	const domain = "t.awtto.com"
	cases := []struct {
		name      string
		httpsPort int
		origin    string
		want      bool
	}{
		{"非默认端口：浏览器带端口 → 放行", 8443, "https://" + domain + ":8443", true},
		{"非默认端口：不带端口 → 拒", 8443, "https://" + domain, false},
		{"非默认端口：端口不对 → 拒", 8443, "https://" + domain + ":9443", false},
		{"443：不带端口 → 放行", 443, "https://" + domain, true},
		{"443：显式写 :443 → 拒（浏览器不会这么发）", 443, "https://" + domain + ":443", false},
		{"端口留空当 443", 0, "https://" + domain, true},
		{"跨站 → 拒", 8443, "https://evil.example.com:8443", false},
		{"同域但 http → 拒", 8443, "http://" + domain + ":8443", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &Agent{cfg: Config{Domain: domain, HTTPSPort: tc.httpsPort}}
			r := httptest.NewRequest(http.MethodGet, "/ws", nil)
			r.Header.Set("Origin", tc.origin)
			if got := a.checkOrigin(r); got != tc.want {
				t.Errorf("checkOrigin(%q) 在 --https-port %d 下 = %v，想要 %v（期望的 Origin 是 %q）",
					tc.origin, tc.httpsPort, got, tc.want, a.allowedOrigin())
			}
		})
	}
}

// 不带 Origin 的非浏览器客户端仍然放行（它们要过 Cookie 认证）。
func TestCheckOriginAbsent(t *testing.T) {
	a := &Agent{cfg: Config{Domain: "t.awtto.com", HTTPSPort: 8443}}
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if !a.checkOrigin(r) {
		t.Error("没有 Origin 头的客户端不该被 Origin 校验拦下")
	}
}

// allowedOrigin 得和配对二维码、301 跳转用的是同一个 URL —— 否则又会漂。
func TestAllowedOriginMatchesExternalURL(t *testing.T) {
	for _, port := range []int{0, 443, 8443} {
		a := &Agent{cfg: Config{Domain: "t.awtto.com", HTTPSPort: port}}
		if got, want := a.allowedOrigin(), externalURL("t.awtto.com", port); got != want {
			t.Errorf("port %d: allowedOrigin=%q，externalURL=%q", port, got, want)
		}
	}
}
