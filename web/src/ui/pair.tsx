/**
 * 配对页。
 *
 * 配对码走 URL **fragment**：它不会发送给服务器，所以不进访问日志、不进
 * Referer、不被中间代理记录（AC-1.5）。读到之后立刻 replaceState 抹掉，
 * 免得留在浏览器历史里。
 */
import { useEffect, useState } from 'preact/hooks'

type PairState = 'idle' | 'pairing' | 'done' | 'failed'

export function PairPage() {
  const [state, setState] = useState<PairState>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const code = location.hash.slice(1)
    if (!code) {
      setState('failed')
      setMessage('这个链接里没有配对码。在服务器上跑 webterm pair 重新生成一个。')
      return
    }
    // 先抹掉 hash，再发请求 —— 万一请求慢，历史里也不会留下配对码
    history.replaceState(null, '', location.pathname)
    setState('pairing')

    fetch('/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code }),
    })
      .then(async (r) => {
        if (r.ok) {
          setState('done')
          location.replace('/')
          return
        }
        const body = (await r.json().catch(() => ({}))) as { message?: string }
        setState('failed')
        setMessage(
          r.status === 429
            ? '尝试过于频繁，请稍后再试。'
            : (body.message ?? '配对码无效或已过期。'),
        )
      })
      .catch(() => {
        setState('failed')
        setMessage('无法连接到 agent。')
      })
  }, [])

  return (
    <main class="pair">
      <h1>webterm</h1>
      {state === 'pairing' && <p data-testid="pair-status">正在配对…</p>}
      {state === 'done' && <p data-testid="pair-status">配对成功，正在跳转…</p>}
      {state === 'failed' && (
        <p data-testid="pair-status" class="error">
          {message}
        </p>
      )}
    </main>
  )
}
