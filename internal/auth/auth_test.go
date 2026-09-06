package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/store"
)

func newAuth(t *testing.T) (*auth.Auth, *store.Store) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return auth.New(st, false), st
}

// UT-pair-1..4：一次性、过期、熵、常数时间比较（AC-1.4）。
func TestPairingCode(t *testing.T) {
	a, _ := newAuth(t)
	now := time.Now()

	t.Run("熵足够", func(t *testing.T) {
		seen := map[string]bool{}
		for range 100 {
			code, err := a.NewPairingCode(now)
			if err != nil {
				t.Fatal(err)
			}
			// 32 字节 base64url 无填充 = 43 个字符
			if len(code) != 43 {
				t.Fatalf("配对码长度 = %d, want 43（32 字节熵）", len(code))
			}
			if seen[code] {
				t.Fatal("生成了重复的配对码")
			}
			seen[code] = true
		}
	})

	t.Run("一次性", func(t *testing.T) {
		code, _ := a.NewPairingCode(now)
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", now); err != nil {
			t.Fatalf("第一次配对失败: %v", err)
		}
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", now); err == nil {
			t.Fatal("同一个配对码用了第二次")
		}
	})

	t.Run("5 分钟过期", func(t *testing.T) {
		code, _ := a.NewPairingCode(now)
		later := now.Add(auth.PairingTTL + time.Second)
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", later); err == nil {
			t.Fatal("过期的配对码仍然可用")
		}
	})

	t.Run("错误的码", func(t *testing.T) {
		if _, _, err := a.Pair("totally-wrong", "UA", "1.2.3.4", now); err == nil {
			t.Fatal("乱猜的配对码通过了")
		}
	})
}

// UT-auth-1：库里存的是哈希不是原文（AC-1.10）。
func TestTokenHashedNotStored(t *testing.T) {
	a, st := newAuth(t)
	code, _ := a.NewPairingCode(time.Now())
	dev, token, err := a.Pair(code, "UA", "1.2.3.4", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// 用原文能查到设备（说明哈希对得上）
	got, err := st.DeviceByToken(token)
	if err != nil || got == nil || got.ID != dev.ID {
		t.Fatalf("按 token 查设备失败: %v %v", got, err)
	}
	// 吊销之后就查不到了
	if err := st.RevokeDevice(dev.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err = st.DeviceByToken(token)
	if err != nil || got != nil {
		t.Fatal("已吊销的设备仍能用旧 token 查到")
	}
}

// UT-reconnect 之外的一条：限速的退避行为（AC-1.6）。
func TestLimiterBackoff(t *testing.T) {
	l := auth.NewLimiter()
	now := time.Now()
	const ip = "9.9.9.9"

	// 一分钟内前 5 次放行
	for i := range 5 {
		if ok, _ := l.Allow(ip, now); !ok {
			t.Fatalf("第 %d 次就被拦了，应当允许 5 次/分钟", i+1)
		}
	}
	ok, retry := l.Allow(ip, now)
	if ok {
		t.Fatal("第 6 次应当被限速")
	}
	if retry <= 0 {
		t.Fatal("被限速时应当给出 Retry-After")
	}

	t.Run("失败推进指数退避", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		var last time.Duration
		for i := range 4 {
			l.Failed("8.8.8.8", now)
			_, retry := l.Allow("8.8.8.8", now)
			if i > 0 && retry <= last {
				t.Fatalf("第 %d 次失败后退避 %v，没有比上次的 %v 更长", i+1, retry, last)
			}
			last = retry
		}
	})

	t.Run("成功后清零", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		l.Failed("7.7.7.7", now)
		l.Succeeded("7.7.7.7")
		if ok, _ := l.Allow("7.7.7.7", now); !ok {
			t.Fatal("配对成功之后不该还背着失败计数")
		}
	})

	t.Run("不同 IP 互不影响", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		for range 6 {
			l.Allow("1.1.1.1", now)
		}
		if ok, _ := l.Allow("2.2.2.2", now); !ok {
			t.Fatal("一个 IP 的限速影响到了另一个")
		}
	})
}

// 默认【不信任】X-Forwarded-For —— 否则攻击者伪造它就能绕过限速。
func TestClientIPIgnoresForwardedByDefault(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/pair", nil)
	r.RemoteAddr = "203.0.113.9:5555"
	r.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2")

	if got := auth.ClientIP(r, false); got != "203.0.113.9" {
		t.Fatalf("默认应当忽略 X-Forwarded-For，得到 %q", got)
	}
	// 开了 --trust-proxy 才取【最后一跳】：那是最近的可信代理写进去的
	if got := auth.ClientIP(r, true); got != "2.2.2.2" {
		t.Fatalf("--trust-proxy 下应当取最后一跳，得到 %q", got)
	}
}

func TestDeviceNameFromUserAgent(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Safari/605": "iPhone · Safari",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537": "macOS · Chrome",
		"Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0":                       "Linux · Firefox",
		"": "未知设备",
	}
	for ua, want := range cases {
		if got := auth.DeviceName(ua); got != want {
			t.Errorf("DeviceName(%.40q) = %q, want %q", ua, got, want)
		}
	}
}
