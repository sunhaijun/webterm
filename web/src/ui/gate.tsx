/**
 * Auth gate: shows pairing instructions instead of a blank page when unpaired.
 *
 * Static assets are served without auth (JS/CSS hold no secrets), so the check happens
 * here: a 401 from /api/devices means this device isn't paired. children render only
 * after that passes.
 *
 * children is a function that receives `revoke`. If the device is revoked mid-use
 * (AC-1.11 / E2E-15), the app calls it and the gate switches to the pairing page with a
 * "revoked" notice.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

type GateState = 'checking' | 'authed' | 'unpaired' | 'revoked' | 'offline'

export interface GateProps {
  children: (revoke: () => void) => ComponentChildren
}

export function Gate({ children }: GateProps) {
  const [gate, setGate] = useState<GateState>('checking')

  useEffect(() => {
    fetch('/api/devices', { credentials: 'same-origin' })
      .then((r) => setGate((g) => (g === 'revoked' ? g : r.status === 401 ? 'unpaired' : 'authed')))
      .catch(() => setGate((g) => (g === 'revoked' ? g : 'offline')))
  }, [])

  if (gate === 'checking') return <main class="gate">Checking pairing…</main>
  if (gate === 'authed') return <>{children(() => setGate('revoked'))}</>
  if (gate === 'offline') {
    // Offline: say so plainly instead of pretending to work
    return (
      <main class="gate" data-testid="offline">
        <h1>Can't reach the agent</h1>
        <p>Check your network and make sure webterm is still running.</p>
      </main>
    )
  }
  return <Unpaired revoked={gate === 'revoked'} />
}

/** Pairing instructions. When revoked, adds a line saying so. */
export function Unpaired({ revoked = false }: { revoked?: boolean }) {
  return (
    <main class="gate" data-testid="unpaired">
      <h1>Pairing required</h1>
      {revoked && (
        <p class="error" data-testid="revoked">
          This device has been revoked.
        </p>
      )}
      <p>This device isn't authorized yet. On the server, run:</p>
      <pre>webterm pair</pre>
      <p>
        Then scan the QR code it prints with this device. If you can't scan it, <a href="/pair">open the pairing page</a> and enter the 16-digit code.
      </p>
    </main>
  )
}
