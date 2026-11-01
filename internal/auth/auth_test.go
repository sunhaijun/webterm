package auth_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/store"
)

func newAuth(t *testing.T) (*auth.Auth, *store.Store) {
	return newAuthTrusting(t, false)
}

func newAuthTrusting(t *testing.T, trustProxy bool) (*auth.Auth, *store.Store) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return auth.New(st, false, trustProxy), st
}

// UT-pair-1..4: single use, expiry, entropy, constant-time compare (AC-1.4).
func TestPairingCode(t *testing.T) {
	a, _ := newAuth(t)
	now := time.Now()

	t.Run("has enough entropy", func(t *testing.T) {
		seen := map[string]bool{}
		for range 100 {
			code, err := a.NewPairingCode(now)
			if err != nil {
				t.Fatal(err)
			}
			// 32 bytes as unpadded base64url = 43 characters
			if len(code) != 43 {
				t.Fatalf("pairing code length = %d, want 43 (32 bytes of entropy)", len(code))
			}
			if seen[code] {
				t.Fatal("generated a duplicate pairing code")
			}
			seen[code] = true
		}
	})

	t.Run("is single use", func(t *testing.T) {
		code, _ := a.NewPairingCode(now)
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", now); err != nil {
			t.Fatalf("first pairing failed: %v", err)
		}
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", now); err == nil {
			t.Fatal("same pairing code worked twice")
		}
	})

	t.Run("expires after 5 minutes", func(t *testing.T) {
		code, _ := a.NewPairingCode(now)
		later := now.Add(auth.PairingTTL + time.Second)
		if _, _, err := a.Pair(code, "UA", "1.2.3.4", later); err == nil {
			t.Fatal("expired pairing code still works")
		}
	})

	t.Run("rejects a wrong code", func(t *testing.T) {
		if _, _, err := a.Pair("totally-wrong", "UA", "1.2.3.4", now); err == nil {
			t.Fatal("guessed pairing code was accepted")
		}
	})
}

// UT-auth-1: the store holds hashes, not plaintext tokens (AC-1.10).
func TestTokenHashedNotStored(t *testing.T) {
	a, st := newAuth(t)
	code, _ := a.NewPairingCode(time.Now())
	dev, token, err := a.Pair(code, "UA", "1.2.3.4", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Looking up by plaintext finds the device, so the hashes match.
	got, err := st.DeviceByToken(token)
	if err != nil || got == nil || got.ID != dev.ID {
		t.Fatalf("device lookup by token failed: %v %v", got, err)
	}
	// After revocation the lookup fails.
	if err := st.RevokeDevice(dev.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err = st.DeviceByToken(token)
	if err != nil || got != nil {
		t.Fatal("revoked device still found by its old token")
	}
}

// Rate limiter backoff behavior (AC-1.6).
func TestLimiterBackoff(t *testing.T) {
	l := auth.NewLimiter()
	now := time.Now()
	const ip = "9.9.9.9"

	// The first 5 attempts within a minute pass.
	for i := range 5 {
		if ok, _ := l.Allow(ip, now); !ok {
			t.Fatalf("blocked on attempt %d; should allow 5 per minute", i+1)
		}
	}
	ok, retry := l.Allow(ip, now)
	if ok {
		t.Fatal("6th attempt should be rate limited")
	}
	if retry <= 0 {
		t.Fatal("rate-limited response should include Retry-After")
	}

	t.Run("failures advance exponential backoff", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		var last time.Duration
		for i := range 4 {
			l.Failed("8.8.8.8", now)
			_, retry := l.Allow("8.8.8.8", now)
			if i > 0 && retry <= last {
				t.Fatalf("backoff after failure %d is %v, not longer than previous %v", i+1, retry, last)
			}
			last = retry
		}
	})

	t.Run("success resets failures", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		l.Failed("7.7.7.7", now)
		l.Succeeded("7.7.7.7")
		if ok, _ := l.Allow("7.7.7.7", now); !ok {
			t.Fatal("failure count should be cleared after a successful pairing")
		}
	})

	t.Run("IPs are independent", func(t *testing.T) {
		l := auth.NewLimiter()
		now := time.Now()
		for range 6 {
			l.Allow("1.1.1.1", now)
		}
		if ok, _ := l.Allow("2.2.2.2", now); !ok {
			t.Fatal("rate limit on one IP affected another")
		}
	})
}

// X-Forwarded-For is ignored by default; otherwise forging it would bypass
// rate limiting.
func TestClientIPIgnoresForwardedByDefault(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/pair", nil)
	r.RemoteAddr = "203.0.113.9:5555"
	r.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2")

	if got := auth.ClientIP(r, false); got != "203.0.113.9" {
		t.Fatalf("X-Forwarded-For should be ignored by default, got %q", got)
	}
	// With --trust-proxy, take the last hop: the nearest trusted proxy wrote it.
	if got := auth.ClientIP(r, true); got != "2.2.2.2" {
		t.Fatalf("--trust-proxy should use the last hop, got %q", got)
	}
}

// last_ip follows the same rule as rate limiting: with --trust-proxy it is
// the last X-Forwarded-For hop. Otherwise every device behind a reverse proxy
// would show the proxy's address.
func TestLastIPHonoursTrustProxy(t *testing.T) {
	for _, tc := range []struct {
		trust bool
		want  string
	}{{false, "203.0.113.9"}, {true, "2.2.2.2"}} {
		a, st := newAuthTrusting(t, tc.trust)
		code, err := a.NewPairingCode(time.Now())
		if err != nil {
			t.Fatal(err)
		}
		_, token, err := a.Pair(code, "UA", "198.51.100.1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
		r.RemoteAddr = "203.0.113.9:5555"
		r.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2")
		r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		if dev, err := a.Authenticate(r); err != nil || dev == nil {
			t.Fatalf("Authenticate = %v, %v", dev, err)
		}
		dev, err := st.DeviceByToken(token)
		if err != nil || dev == nil {
			t.Fatal(err)
		}
		if dev.LastIP != tc.want {
			t.Errorf("trustProxy=%v: last_ip = %q, want %q", tc.trust, dev.LastIP, tc.want)
		}
	}
}

// Idle IPs are forgotten: an IP that tried once, or failed and never came
// back, must not stay in the table forever. The pairing endpoint is open to
// the whole internet.
func TestLimiterForgetsIdleIPs(t *testing.T) {
	l := auth.NewLimiter()
	now := time.Now()
	l.Allow("1.1.1.1", now)
	l.Failed("1.1.1.1", now)
	l.Allow("2.2.2.2", now)

	later := now.Add(11 * time.Minute) // past the GC period
	l.Allow("3.3.3.3", later.Add(-30*time.Second))
	l.Allow("4.4.4.4", later)
	if n := l.TrackedIPsForTest(); n != 2 {
		t.Fatalf("tracking %d IPs, want 2 (the two idle for 10 minutes should be gone)", n)
	}
}

func TestDeviceNameFromUserAgent(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Safari/605": "iPhone · Safari",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537": "macOS · Chrome",
		"Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0":                       "Linux · Firefox",
		"": "Unknown device",
	}
	for ua, want := range cases {
		if got := auth.DeviceName(ua); got != want {
			t.Errorf("DeviceName(%.40q) = %q, want %q", ua, got, want)
		}
	}
}

// UT-pair-5: numeric pairing code (ADR-0017): 16 digits, uniform, may be
// typed with separators, and shares its fate with the URL code.
func TestPairingDigits(t *testing.T) {
	a, _ := newAuth(t)
	now := time.Now()

	t.Run("is 16 unique decimal digits", func(t *testing.T) {
		seen := map[string]bool{}
		for range 50 {
			c, err := a.NewPairingCodes(now)
			if err != nil {
				t.Fatal(err)
			}
			if len(c.Digits) != auth.DigitsLen || strings.Trim(c.Digits, "0123456789") != "" {
				t.Fatalf("numeric code %q is not 16 decimal digits", c.Digits)
			}
			if seen[c.Digits] {
				t.Fatal("generated a duplicate numeric code")
			}
			seen[c.Digits] = true
		}
	})

	t.Run("formats in groups and normalizes", func(t *testing.T) {
		if got := auth.FormatDigits("4821093755661204"); got != "4821-0937-5566-1204" {
			t.Fatalf("FormatDigits = %q", got)
		}
		for _, in := range []string{"4821-0937-5566-1204", "4821 0937 5566 1204", " 4821093755661204 ", "4821-0937 5566-1204"} {
			if got := auth.NormalizeCode(in); got != "4821093755661204" {
				t.Fatalf("NormalizeCode(%q) = %q", in, got)
			}
		}
		// Anything that isn't 16 digits is returned as is; URL codes may contain '-'.
		if got := auth.NormalizeCode("kJ8x-abc_DEF"); got != "kJ8x-abc_DEF" {
			t.Fatalf("URL code was modified: %q", got)
		}
	})

	t.Run("typed digits with separators pair and invalidate the URL code", func(t *testing.T) {
		c, _ := a.NewPairingCodes(now)
		if _, _, err := a.Pair(auth.FormatDigits(c.Digits), "UA", "1.2.3.4", now); err != nil {
			t.Fatalf("pairing with numeric code failed: %v", err)
		}
		if _, _, err := a.Pair(c.URL, "UA", "1.2.3.4", now); err == nil {
			t.Fatal("URL code still works after the numeric code was used; both keys must expire together")
		}
	})

	t.Run("using the URL code invalidates the digits", func(t *testing.T) {
		c, _ := a.NewPairingCodes(now)
		if _, _, err := a.Pair(c.URL, "UA", "1.2.3.4", now); err != nil {
			t.Fatal(err)
		}
		if _, _, err := a.Pair(c.Digits, "UA", "1.2.3.4", now); err == nil {
			t.Fatal("numeric code still works after the URL code was used")
		}
	})

	t.Run("rejects one wrong digit", func(t *testing.T) {
		c, _ := a.NewPairingCodes(now)
		wrong := []byte(c.Digits)
		wrong[15] = '0' + (wrong[15]-'0'+1)%10
		if _, _, err := a.Pair(string(wrong), "UA", "1.2.3.4", now); err == nil {
			t.Fatal("numeric code with one wrong digit was accepted")
		}
		if _, _, err := a.Pair(c.Digits, "UA", "1.2.3.4", now); err != nil {
			t.Fatal("a wrong guess must not invalidate the correct code")
		}
	})
}
