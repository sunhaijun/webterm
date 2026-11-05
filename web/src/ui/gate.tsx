/**
 * Auth gate: shows pairing instructions instead of a blank page when unpaired.
 *
 * Static assets are served without auth (JS/CSS hold no secrets), so the check happens
 * here: a 401 from /api/devices means this device isn't paired. children render only
 * after that passes.
 *
 * children is a function that receives `revoke` and `signedOut`. If the device is
 * revoked mid-use (AC-1.11 / E2E-15), or signs itself out (AC-1.22), the app calls one and
 * the gate switches to the pairing page with a notice saying which.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

import { readForm } from '../app/form'
import { isCoarsePointer } from './viewport'

/** How often an unreachable agent is checked again at startup (ADR-0049 §3). */
export const GATE_RETRY_MS = 3000

type GateState = 'checking' | 'authed' | 'unpaired' | 'revoked' | 'signedOut' | 'offline'

export interface GateProps {
  children: (revoke: () => void, signedOut: () => void) => ComponentChildren
}

export function Gate({ children }: GateProps) {
  const [gate, setGate] = useState<GateState>('checking')

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const check = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      fetch('/api/devices', { credentials: 'same-origin' })
        .then(async (r) => {
          // A revoked device's cookie gets code "revoked" (AC-1.11): say so, as when revoked mid-use
          const next: GateState = r.status !== 401 ? 'authed' : (await errorCode(r)) === 'revoked' ? 'revoked' : 'unpaired'
          setGate((g) => (g === 'checking' || g === 'offline' ? next : g))
        })
        .catch(() => {
          setGate((g) => (g === 'checking' || g === 'offline' ? 'offline' : g))
          // Unreachable at startup: keep trying, like a reconnect would (ADR-0049 §3)
          if (!stopped) timer = setTimeout(check, GATE_RETRY_MS)
        })
    }
    check()
    addEventListener('online', check)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      removeEventListener('online', check)
    }
  }, [])

  if (gate === 'checking') return <Skeleton offline={false} />
  if (gate === 'offline') return <Skeleton offline />
  if (gate === 'authed')
    return (
      <>
        {children(
          () => setGate('revoked'),
          () => setGate('signedOut'),
        )}
      </>
    )
  return <Unpaired revoked={gate === 'revoked'} signedOut={gate === 'signedOut'} />
}

/**
 * The app's frame while the gate checks pairing (ADR-0049 §2): same form, same tab bar
 * height, and the connection banner where the app will show it. Startup messages are
 * then in the same place as every later connection message, instead of jumping.
 */
function Skeleton({ offline }: { offline: boolean }) {
  const form = readForm()
  return (
    <div
      class="app"
      data-form={form}
      data-coarse={isCoarsePointer() ? 'true' : 'false'}
      data-testid={offline ? 'offline' : 'gate-checking'}
    >
      {form === 'wide' && <div class="topbar" />}
      <div class="stage">
        <div class="conn-banner" data-state={offline ? 'fatal' : 'connecting'} data-testid="conn-banner">
          <span data-testid="conn-text" role="status" aria-live="polite">
            {offline ? "Can't reach the agent · retrying" : 'Connecting…'}
          </span>
        </div>
      </div>
    </div>
  )
}

async function errorCode(r: Response): Promise<string | undefined> {
  try {
    return ((await r.json()) as { code?: string }).code
  } catch {
    return undefined
  }
}

/** Pairing instructions. When revoked or signed out, adds a line saying so. */
export function Unpaired({ revoked = false, signedOut = false }: { revoked?: boolean; signedOut?: boolean }) {
  return (
    <main class="gate" data-testid="unpaired">
      <h1>Pairing required</h1>
      {revoked && (
        <p class="error" data-testid="revoked">
          This device has been revoked.
        </p>
      )}
      {signedOut && <p data-testid="signed-out">Signed out.</p>}
      <p>This device isn't authorized yet. On the server, run:</p>
      <pre>webterm pair</pre>
      <p>
        Then scan the QR code it prints with this device. If you can't scan it, <a href="/pair">open the pairing page</a> and enter the 16-digit code.
      </p>
    </main>
  )
}
