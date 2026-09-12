// Package auth 负责配对、设备会话与限速。
//
// 单用户、多设备。没有账号体系、没有密码。设计见
// docs/60-security/auth-pairing.md，威胁分析见 threat-model.md。
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
	// CookieName 是会话 Cookie 的名字。
	CookieName = "webterm_session"
	// PairingTTL：配对码 5 分钟过期（AC-1.4）。
	PairingTTL = 5 * time.Minute
	// CookieMaxAge：1 年。
	CookieMaxAge = 365 * 24 * time.Hour
	// renewThreshold：Cookie 剩余有效期少于它就滑动续期，常用设备永不掉线。
	renewThreshold = 30 * 24 * time.Hour
	// touchInterval：last_seen_at / last_ip 的写库节流。
	touchInterval = 60 * time.Second
	// tokenBytes / codeBytes：32 字节熵（AC-1.4）。
	tokenBytes = 32
	codeBytes  = 32
)

// ErrInvalidCode 表示配对码无效。
var ErrInvalidCode = errors.New("auth: 配对码无效")

// Auth 是认证服务。
type Auth struct {
	store   *store.Store
	dev     bool // --dev：Cookie 不带 Secure
	limiter *Limiter

	mu          sync.Mutex
	lastTouched map[string]time.Time // device id → 上次写库时间
}

// New 创建认证服务。dev 为 true 时 Cookie 省略 Secure（localhost 明文）。
func New(st *store.Store, dev bool) *Auth {
	return &Auth{
		store:       st,
		dev:         dev,
		limiter:     NewLimiter(),
		lastTouched: make(map[string]time.Time),
	}
}

// Limiter 暴露限速器，供路由层使用。
func (a *Auth) Limiter() *Limiter { return a.limiter }

// randomToken 生成 n 字节熵的 base64url 字符串。
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Codes 是一次配对的两把钥匙（ADR-0017）：URL 走二维码 / fragment，Digits 手输。
// 哈希存同一行，任一把用掉整行作废。
type Codes struct {
	URL    string
	Digits string // 16 位十进制，显示时用 FormatDigits 分组
}

// DigitsLen 是数字配对码的位数。16 位 ≈ 53 bit，在既有限速下够用（ADR-0017 有推导）。
const DigitsLen = 16

// NewPairingCodes 生成一次性配对码（两把钥匙）并落库（只存哈希）。
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

// NewPairingCode 只返回 URL 码 —— 给只关心二维码路径的调用方与旧测试。
func (a *Auth) NewPairingCode(now time.Time) (string, error) {
	c, err := a.NewPairingCodes(now)
	return c.URL, err
}

// randomDigits 生成 n 位均匀分布的十进制数字。
//
// 拒绝采样：一个随机字节只在 < 250 时取模 —— 250 是 10 的倍数，模 10 才均匀；
// 直接 b % 10 会让 0..5 比 6..9 多出现 1/256，白白送熵。
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

// FormatDigits 把数字码按 4 位一组、用 - 分开：1234-5678-9012-3456。
// 终端打印与配对页显示都用它 —— 便于看、便于念。
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

// NormalizeCode 把用户提交的配对码规整成可比对的形式：剥掉空格与 -，
// 剩下的是 16 位纯数字就当数字码，否则原样（URL 码）返回。
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

// Pair 消费一个配对码，创建设备并返回会话 token。
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

// Authenticate 按请求里的 Cookie 查设备。无效返回 (nil, nil)。
func (a *Auth) Authenticate(r *http.Request) (*store.Device, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	dev, err := a.store.DeviceByToken(c.Value)
	if err != nil || dev == nil {
		return nil, err
	}
	a.touch(dev, ClientIP(r, false), time.Now())
	return dev, nil
}

// touch 按节流更新 last_seen_at / last_ip，避免每个请求都写库。
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

// SetSessionCookie 在响应上写会话 Cookie。
func (a *Auth) SetSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,                    // JS 读不到，XSS 偷不走
		Secure:   !a.dev,                  // --dev 下 localhost 明文
		SameSite: http.SameSiteStrictMode, // 防 CSRF
		MaxAge:   int(CookieMaxAge.Seconds()),
	})
}

// ClearSessionCookie 让浏览器丢掉会话 Cookie。
func (a *Auth) ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/",
		HttpOnly: true, Secure: !a.dev,
		SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
}

// MaybeRenew 做滑动续期：剩余有效期不足 30 天就重发 Cookie。
//
// 不做 token 轮换 —— 轮换要处理"并发请求拿到旧 token"的竞态，而在有即时
// 吊销的前提下，限制被盗 token 有效期的收益并不明显。
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

// DeviceName 从 User-Agent 粗略推断一个设备名（如 "iPhone · Safari"）。
// 只用于人眼识别，猜错了用户可以改。
func DeviceName(ua string) string {
	platform := "未知设备"
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
