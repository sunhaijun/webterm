/**
 * 配对页。
 *
 * 配对码走 URL **fragment**：它不会发送给服务器，所以不进访问日志、不进
 * Referer、不被中间代理记录（AC-1.5）。读到之后立刻 replaceState 抹掉，
 * 免得留在浏览器历史里。
 *
 * 没有 fragment（用户直接打开 /pair）时是手输入口（ADR-0017）：终端里那
 * 16 位数字，空格 / - 都接受，边输边按 4 位分组，满 16 位才能提交。
 */
import { useEffect, useRef, useState } from 'preact/hooks'

import { PAIR_DIGITS_LEN, formatPairDigits, normalizePairDigits } from './paircode'

type PairState = 'idle' | 'entry' | 'pairing' | 'done' | 'failed'

export function PairPage() {
  const [state, setState] = useState<PairState>('idle')
  const [message, setMessage] = useState('')
  const [digits, setDigits] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = (code: string) => {
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
  }

  useEffect(() => {
    const code = location.hash.slice(1)
    if (!code) {
      setState('entry')
      return
    }
    // 先抹掉 hash，再发请求 —— 万一请求慢，历史里也不会留下配对码
    history.replaceState(null, '', location.pathname)
    submit(code)
  }, [])

  // 失败后仍能重试：表单留着（fragment 路径失败的人也可以改用手输）
  const showForm = state === 'entry' || state === 'failed'
  const ready = digits.length === PAIR_DIGITS_LEN

  return (
    <main class="pair">
      <h1>webterm</h1>
      {showForm && (
        <form
          class="pair-form"
          data-testid="pair-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) submit(digits)
          }}
        >
          <p>
            在服务器上执行 <code>webterm pair</code>，把终端里打印的 16 位数字填在这里（扫二维码也可以）：
          </p>
          <input
            ref={inputRef}
            class="pair-code"
            data-testid="pair-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="1234-5678-9012-3456"
            maxLength={PAIR_DIGITS_LEN + 3}
            value={formatPairDigits(digits)}
            onInput={(e) => setDigits(normalizePairDigits(e.currentTarget.value).slice(0, PAIR_DIGITS_LEN))}
          />
          <button type="submit" data-testid="pair-submit" disabled={!ready}>
            配对
          </button>
        </form>
      )}
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
