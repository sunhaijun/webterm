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

type GateState = 'checking' | 'authed' | 'unpaired' | 'revoked' | 'signedOut' | 'offline'

export interface GateProps {
  children: (revoke: () => void, signedOut: () => void) => ComponentChildren
}

export function Gate({ children }: GateProps) {
  const [gate, setGate] = useState<GateState>('checking')

  useEffect(() => {
    fetch('/api/devices', { credentials: 'same-origin' })
      .then(async (r) => {
        // A revoked device's cookie gets code "revoked" (AC-1.11): say so, as when revoked mid-use
        const next: GateState = r.status !== 401 ? 'authed' : (await errorCode(r)) === 'revoked' ? 'revoked' : 'unpaired'
        setGate((g) => (g !== 'checking' ? g : next))
      })
      .catch(() => setGate((g) => (g !== 'checking' ? g : 'offline')))
  }, [])

  if (gate === 'checking') return <main class="gate">Checking pairing…</main>
  if (gate === 'authed')
    return (
      <>
        {children(
          () => setGate('revoked'),
          () => setGate('signedOut'),
        )}
      </>
    )
  if (gate === 'offline') {
    // Offline: say so plainly instead of pretending to work
    return (
      <main class="gate" data-testid="offline">
        <h1>Can't reach the agent</h1>
        <p>Check your network and make sure webterm is still running.</p>
      </main>
    )
  }
  return <Unpaired revoked={gate === 'revoked'} signedOut={gate === 'signedOut'} />
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
