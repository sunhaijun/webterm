package auth

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 限速参数（AC-1.6）。只对 POST /auth/pair 限速 ——
// 其它路由要么是静态资源，要么已经要求认证。
const (
	perIPPerMinute  = 5
	backoffBase     = time.Second
	backoffMax      = 5 * time.Minute
	globalFailures  = 50
	globalWindow    = time.Hour
	globalCooldown  = 10 * time.Minute
	limiterGCPeriod = 10 * time.Minute
)

type ipState struct {
	attempts  []time.Time // 滑动窗口内的尝试
	failures  int         // 连续失败次数，驱动指数退避
	blockedTo time.Time
}

// Limiter 是配对接口的限速器。
//
// 状态只在内存里（重启即清），不落库 —— 它保护的是一个 5 分钟就过期的
// 一次性配对码，重启后重来一遍的窗口本来就极窄。
type Limiter struct {
	mu              sync.Mutex
	ips             map[string]*ipState
	global          []time.Time // 全局失败时间戳
	globalBlockedTo time.Time
	lastGC          time.Time
}

// NewLimiter 创建限速器。
func NewLimiter() *Limiter {
	return &Limiter{ips: make(map[string]*ipState), lastGC: time.Now()}
}

// Allow 报告某个 IP 现在能否尝试配对。不允许时返回建议的 Retry-After。
func (l *Limiter) Allow(ip string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.gcLocked(now)

	// 全局熔断：任意 IP 累计失败到阈值就整体停一会儿，并在 stdout 打告警
	if now.Before(l.globalBlockedTo) {
		return false, l.globalBlockedTo.Sub(now)
	}

	st := l.ips[ip]
	if st == nil {
		st = &ipState{}
		l.ips[ip] = st
	}
	if now.Before(st.blockedTo) {
		return false, st.blockedTo.Sub(now)
	}

	cutoff := now.Add(-time.Minute)
	kept := st.attempts[:0]
	for _, t := range st.attempts {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	st.attempts = kept
	if len(st.attempts) >= perIPPerMinute {
		// 至少要等到最早那次尝试滑出一分钟窗口；连续失败过的话再叠上退避。
		// 【必须给出一个正的时长】—— 客户端拿它做倒计时，返回 0 等于让它
		// 立刻重试，限速就形同虚设。
		wait := st.attempts[0].Add(time.Minute).Sub(now)
		if b := l.backoffFor(st.failures); b > wait {
			wait = b
		}
		if wait <= 0 {
			wait = time.Second
		}
		st.blockedTo = now.Add(wait)
		return false, wait
	}
	st.attempts = append(st.attempts, now)
	return true, 0
}

// Failed 记一次配对失败，推进指数退避。
func (l *Limiter) Failed(ip string, now time.Time) (globalTripped bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.ips[ip]
	if st == nil {
		st = &ipState{}
		l.ips[ip] = st
	}
	st.failures++
	st.blockedTo = now.Add(l.backoffFor(st.failures - 1))

	cutoff := now.Add(-globalWindow)
	kept := l.global[:0]
	for _, t := range l.global {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.global = append(kept, now)
	if len(l.global) >= globalFailures && now.After(l.globalBlockedTo) {
		l.globalBlockedTo = now.Add(globalCooldown)
		return true
	}
	return false
}

// Succeeded 清掉某个 IP 的失败计数。
func (l *Limiter) Succeeded(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.ips, ip)
}

// backoffFor 返回第 n 次连续失败后的退避时长：1s, 2s, 4s… 上限 5 分钟。
func (l *Limiter) backoffFor(n int) time.Duration {
	if n <= 0 {
		return 0
	}
	d := backoffBase
	for range n - 1 {
		d *= 2
		if d >= backoffMax {
			return backoffMax
		}
	}
	return d
}

// gcLocked 定期丢掉长时间没动静的 IP 记录，防止 map 无界增长。
func (l *Limiter) gcLocked(now time.Time) {
	if now.Sub(l.lastGC) < limiterGCPeriod {
		return
	}
	l.lastGC = now
	for ip, st := range l.ips {
		if len(st.attempts) == 0 && now.After(st.blockedTo) {
			delete(l.ips, ip)
		}
	}
}

// ClientIP 取请求的来源 IP。
//
// 【默认不信任 X-Forwarded-For】—— 否则攻击者可以伪造它绕过限速。
// 只有明确开了 --trust-proxy 才用它，且取【最后一跳】（最近的可信代理
// 追加的那个才是它看到的真实客户端）。
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
