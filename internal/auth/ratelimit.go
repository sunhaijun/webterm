package auth

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Rate limit parameters (AC-1.6). Only POST /auth/pair is limited; every
// other route either serves static assets or already requires auth.
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
	attempts  []time.Time // attempts within the sliding window
	failures  int         // consecutive failures; drives exponential backoff
	blockedTo time.Time
}

// Limiter rate-limits the pairing endpoint.
//
// State lives only in memory and resets on restart. It protects a one-time
// code that expires in 5 minutes, so the extra window a restart opens is tiny.
type Limiter struct {
	mu     sync.Mutex
	ips    map[string]*ipState
	global []time.Time // global failure timestamps
	// inflight counts attempts that passed Allow and haven't reported Failed
	// or Succeeded yet. They count against the global budget: otherwise a
	// burst of parallel attempts from many IPs all pass Allow before the first
	// failure is recorded, and the hourly cap means nothing.
	inflight        int
	globalBlockedTo time.Time
	lastGC          time.Time
}

// NewLimiter creates a Limiter.
func NewLimiter() *Limiter {
	return &Limiter{ips: make(map[string]*ipState), lastGC: time.Now()}
}

// Allow reports whether ip may attempt pairing now. If not, it also returns
// the suggested Retry-After.
func (l *Limiter) Allow(ip string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.gcLocked(now)

	// Global circuit breaker: once failures across all IPs hit the threshold,
	// pause everyone for a while. The caller of Failed logs the alert.
	if now.Before(l.globalBlockedTo) {
		return false, l.globalBlockedTo.Sub(now)
	}
	// Attempts in flight could each still fail: don't let them overshoot the
	// global budget. Once the breaker has tripped and cooled down, this
	// allows one at a time, as before (the next failure trips it again).
	if l.inflight > 0 && l.recentGlobalLocked(now)+l.inflight >= globalFailures {
		return false, time.Second
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
		// Wait at least until the oldest attempt leaves the one-minute window,
		// longer if backoff from consecutive failures says so. The wait must
		// be positive: the client counts down from it, and 0 would mean
		// "retry now", defeating the limit.
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
	l.inflight++
	return true, 0
}

// recentGlobalLocked drops global failures older than the window and returns
// how many remain.
func (l *Limiter) recentGlobalLocked(now time.Time) int {
	cutoff := now.Add(-globalWindow)
	kept := l.global[:0]
	for _, t := range l.global {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.global = kept
	return len(l.global)
}

// doneLocked ends an attempt that Allow let through.
func (l *Limiter) doneLocked() {
	if l.inflight > 0 {
		l.inflight--
	}
}

// Failed records a failed pairing attempt and advances the backoff.
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
	l.doneLocked()

	l.recentGlobalLocked(now)
	l.global = append(l.global, now)
	if len(l.global) >= globalFailures && now.After(l.globalBlockedTo) {
		l.globalBlockedTo = now.Add(globalCooldown)
		return true
	}
	return false
}

// Succeeded clears the failure count for ip.
func (l *Limiter) Succeeded(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.ips, ip)
	l.doneLocked()
}

// backoffFor returns the backoff after n consecutive failures: 1s, 2s, 4s…,
// capped at 5 minutes.
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

// gcLocked periodically drops idle IP entries so the map can't grow without
// bound.
//
// An entry is idle when its last attempt is outside the one-minute window and
// it is not blocked. attempts is only trimmed when that IP comes back, so
// checking whether it is empty is not enough: an IP that tried once and never
// returned would stay forever.
func (l *Limiter) gcLocked(now time.Time) {
	if now.Sub(l.lastGC) < limiterGCPeriod {
		return
	}
	l.lastGC = now
	cutoff := now.Add(-time.Minute)
	for ip, st := range l.ips {
		if n := len(st.attempts); (n == 0 || !st.attempts[n-1].After(cutoff)) && now.After(st.blockedTo) {
			delete(l.ips, ip)
		}
	}
}

// ClientIP returns the client IP of the request.
//
// X-Forwarded-For is not trusted by default; otherwise an attacker could forge
// it to bypass rate limiting. It is used only with --trust-proxy, and then
// only the last hop: the entry appended by the nearest trusted proxy is the
// real client that proxy saw.
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
