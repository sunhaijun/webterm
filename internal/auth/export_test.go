package auth

// TrackedIPsForTest 返回限速器此刻记着几个 IP。
func (l *Limiter) TrackedIPsForTest() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.ips)
}
