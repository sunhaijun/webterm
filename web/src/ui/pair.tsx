/**
 * Pairing page.
 *
 * The pairing code travels in the URL fragment, which is never sent to the server, so it
 * stays out of access logs, Referer headers and proxies (AC-1.5). It is wiped with
 * replaceState as soon as it is read, so it doesn't linger in browser history.
 *
 * Without a fragment (the user opened /pair directly) this is the manual entry form
 * (ADR-0017): the 16 digits from the terminal, spaces and `-` accepted, grouped by 4 as
 * you type; submit is enabled at 16 digits.
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
            ? 'Too many attempts. Try again later'
            : (body.message ?? 'Invalid or expired pairing code'),
        )
      })
      .catch(() => {
        setState('failed')
        setMessage("Can't reach the agent")
      })
  }

  useEffect(() => {
    const code = location.hash.slice(1)
    if (!code) {
      setState('entry')
      return
    }
    // Wipe the hash before the request, so a slow request can't leave the code in history
    history.replaceState(null, '', location.pathname)
    submit(code)
  }, [])

  // Keep the form after a failure so the user can retry (a failed fragment link can fall back to manual entry)
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
            Run <code>webterm pair</code> on the server and enter the 16-digit code it prints (or scan the QR code):
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
            Pair
          </button>
        </form>
      )}
      {state === 'pairing' && <p data-testid="pair-status">Pairing…</p>}
      {state === 'done' && <p data-testid="pair-status">Paired. Redirecting…</p>}
      {state === 'failed' && (
        <p data-testid="pair-status" class="error">
          {message}
        </p>
      )}
    </main>
  )
}
