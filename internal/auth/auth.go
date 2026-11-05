// Package auth handles pairing, device sessions and rate limiting.
//
// One user, many devices; no accounts, no passwords. See
// docs/60-security/auth-pairing.md for the design and threat-model.md for the
// threat analysis.
package auth

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

const (
	// CookieName is the name of the session cookie.
	CookieName = "webterm_session"
	// PairingTTL is how long a pairing code stays valid (AC-1.4).
	PairingTTL = 5 * time.Minute
	// CookieMaxAge is the session cookie lifetime: one year.
	CookieMaxAge = 365 * 24 * time.Hour
	// renewThreshold: when less than this remains, the cookie is renewed, so
	// devices in regular use never get signed out.
	renewThreshold = 30 * 24 * time.Hour
	// touchInterval throttles writes of last_seen_at / last_ip.
	touchInterval = 60 * time.Second
	// tokenBytes / codeBytes: 32 bytes of entropy (AC-1.4).
	tokenBytes = 32
	codeBytes  = 32
)

// ErrInvalidCode means the pairing code is invalid.
var ErrInvalidCode = errors.New("auth: invalid pairing code")

// Auth is the authentication service.
type Auth struct {
	store      *store.Store
	dev        bool // --dev: cookie without Secure
	trustProxy bool // --trust-proxy: last_ip comes from the last X-Forwarded-For hop
	limiter    *Limiter

	mu          sync.Mutex
	lastTouched map[string]time.Time // device id → last write to the store
}

// New creates the authentication service. With dev set, cookies omit Secure
// (plain HTTP on localhost). trustProxy mirrors --trust-proxy and decides
// where the recorded last_ip comes from (see ClientIP).
func New(st *store.Store, dev, trustProxy bool) *Auth {
	return &Auth{
		store:       st,
		dev:         dev,
		trustProxy:  trustProxy,
		limiter:     NewLimiter(),
		lastTouched: make(map[string]time.Time),
	}
}

// Limiter returns the rate limiter for use by the router.
func (a *Auth) Limiter() *Limiter { return a.limiter }

// randomToken returns a base64url string carrying n bytes of entropy.
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Codes holds the two keys of one pairing (ADR-0017): URL goes in the QR code
// / URL fragment, Digits are typed by hand. Both hashes live in the same row;
// using either key invalidates the row.
type Codes struct {
	URL    string
	Digits string // 16 decimal digits; group with FormatDigits for display
}

// DigitsLen is the length of the numeric pairing code. 16 digits ≈ 53 bits,
// enough under the existing rate limits (derivation in ADR-0017).
const DigitsLen = 16

// NewPairingCodes generates a one-time pairing (both keys) and stores their
// hashes.
func (a *Auth) NewPairingCodes(now time.Time) (Codes, error) {
	code, err := randomToken(codeBytes)
	if err != nil {
		return Codes{}, err
	}
	digits, err := randomDigits(DigitsLen)
	if err != nil {
		return Codes{}, err
	}
	if err := a.store.CreatePairing(code, digits, now, PairingTTL); err != nil {
		return Codes{}, err
	}
	return Codes{URL: code, Digits: digits}, nil
}

// NewPairingCode returns only the URL code, for callers and older tests that
// care only about the QR code path.
func (a *Auth) NewPairingCode(now time.Time) (string, error) {
	c, err := a.NewPairingCodes(now)
	return c.URL, err
}

// randomDigits returns n uniformly distributed decimal digits.
//
// It uses rejection sampling: a random byte is used only if it is < 250, a
// multiple of 10, so b % 10 is uniform. A plain b % 10 over all 256 values
// would bias 0..5 over 6..9 and leak entropy.
func randomDigits(n int) (string, error) {
	out := make([]byte, 0, n)
	buf := make([]byte, 2*n)
	for len(out) < n {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b >= 250 {
				continue
			}
			out = append(out, '0'+b%10)
			if len(out) == n {
				break
			}
		}
	}
	return string(out), nil
}

// FormatDigits groups the numeric code in fours separated by '-':
// 1234-5678-9012-3456. Both the terminal printout and the pairing page use it
// so the code is easy to read aloud.
func FormatDigits(d string) string {
	var b strings.Builder
	for i, r := range d {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// NormalizeCode puts a submitted pairing code into comparable form. It strips
// spaces and dashes; if 16 digits remain, that is the numeric code. Otherwise
// it returns the input unchanged (a URL code).
func NormalizeCode(s string) string {
	s = strings.TrimSpace(s)
	stripped := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == '\u2013' || r == '\u2014' {
			return -1
		}
		return r
	}, s)
	if len(stripped) == DigitsLen && strings.Trim(stripped, "0123456789") == "" {
		return stripped
	}
	return s
}

// Pair consumes a pairing code, creates a device and returns its session
// token.
func (a *Auth) Pair(code, userAgent, ip string, now time.Time) (*store.Device, string, error) {
	if err := a.store.ConsumePairing(NormalizeCode(code), now); err != nil {
		return nil, "", ErrInvalidCode
	}
	token, err := randomToken(tokenBytes)
	if err != nil {
		return nil, "", err
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, "", err
	}
	dev, err := a.store.CreateDevice(hex.EncodeToString(idBytes), DeviceName(userAgent), token, ip, now)
	if err != nil {
		return nil, "", err
	}
	return dev, token, nil
}

// Authenticate looks up the device for the request's cookie. It returns
// (nil, nil) when the cookie is missing or invalid.
func (a *Auth) Authenticate(r *http.Request) (*store.Device, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	dev, err := a.store.DeviceByToken(c.Value)
	if err != nil || dev == nil {
		return nil, err
	}
	a.touch(dev, ClientIP(r, a.trustProxy), time.Now())
	return dev, nil
}

// Revoked reports whether the request carries the cookie of a revoked device
// (AC-1.11), so the rejection can say why.
func (a *Auth) Revoked(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	revoked, err := a.store.TokenRevoked(c.Value)
	return err == nil && revoked
}

// touch updates last_seen_at / last_ip, throttled so that not every request
// writes to the store.
func (a *Auth) touch(dev *store.Device, ip string, now time.Time) {
	a.mu.Lock()
	last := a.lastTouched[dev.ID]
	if now.Sub(last) < touchInterval {
		a.mu.Unlock()
		return
	}
	a.lastTouched[dev.ID] = now
	a.mu.Unlock()
	_ = a.store.TouchDevice(dev.ID, ip, now)
}

// SetSessionCookie sets the session cookie on the response.
func (a *Auth) SetSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,                    // invisible to JS, so XSS can't steal it
		Secure:   !a.dev,                  // plain HTTP on localhost under --dev
		SameSite: http.SameSiteStrictMode, // CSRF protection
		MaxAge:   int(CookieMaxAge.Seconds()),
	})
}

// ClearSessionCookie tells the browser to drop the session cookie.
func (a *Auth) ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/",
		HttpOnly: true, Secure: !a.dev,
		SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
}

// MaybeRenew implements sliding expiry: it reissues the cookie when less than
// 30 days remain.
//
// Tokens are not rotated. Rotation must handle concurrent requests that still
// carry the old token, and with instant revocation the benefit of limiting a
// stolen token's lifetime is small.
func (a *Auth) MaybeRenew(w http.ResponseWriter, r *http.Request, dev *store.Device, now time.Time) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return
	}
	expiry := time.UnixMilli(dev.CreatedAt).Add(CookieMaxAge)
	if expiry.Sub(now) < renewThreshold {
		a.SetSessionCookie(w, c.Value)
	}
}

// DeviceName guesses a device name from the User-Agent, such as
// "iPhone · Safari". It is only for humans to recognize the device; users can
// rename it if the guess is wrong.
func DeviceName(ua string) string {
	platform := "Unknown device"
	switch {
	case strings.Contains(ua, "iPhone"):
		platform = "iPhone"
	case strings.Contains(ua, "iPad"):
		platform = "iPad"
	case strings.Contains(ua, "Android"):
		platform = "Android"
	case strings.Contains(ua, "Macintosh"), strings.Contains(ua, "Mac OS X"):
		platform = "macOS"
	case strings.Contains(ua, "Windows"):
		platform = "Windows"
	case strings.Contains(ua, "Linux"):
		platform = "Linux"
	}
	browser := ""
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Chrome/"):
		browser = "Chrome"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	if browser == "" {
		return platform
	}
	return platform + " · " + browser
}
