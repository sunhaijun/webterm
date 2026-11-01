package auth

// TrackedIPsForTest returns how many IPs the limiter currently tracks.
func (l *Limiter) TrackedIPsForTest() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.ips)
}
