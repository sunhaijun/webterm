package session

// SetChildOOMAdjForTest 改起 shell 时子进程的 oom_score_adj 目标值，返回恢复函数。
// IT-oom-1 用它在没有特权的情况下走真 /proc：把目标值调到比自己高（调高不需要特权，
// 调回自己的值也不会低于下限）。
func SetChildOOMAdjForTest(v int) (restore func()) {
	old := childOOMAdj
	childOOMAdj = v
	return func() { childOOMAdj = old }
}
