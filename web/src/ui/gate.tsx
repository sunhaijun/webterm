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
 *
 * With several machines (ADR-0062 §7, §9) the gate checks the current one. Another machine
 * that can't be reached, isn't paired or revokes this device isn't a pairing page: the gate
 * reports it with `onUnavailable` and the page goes back to its own machine.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

import { readForm } from '../app/form'
import { check, type Check } from '../machines/client'
import { isCoarsePointer } from './viewport'

/** How often an unreachable agent is checked again at startup (ADR-0049 §3). */
export const GATE_RETRY_MS = 3000

type GateState = 'checking' | 'authed' | 'unpaired' | 'revoked' | 'signedOut' | 'offline'

export interface GateProps {
  children: (revoke: () => void, signedOut: () => void) => ComponentChildren
  /** The machine to check: `''` is the page's own (relative URLs), otherwise another machine's origin. */
  machine?: string
  /** Another machine is unusable; the page switches to its own (ADR-0062 §7, §9). */
  onUnavailable?(why: Exclude<Check, 'ok'>): void
  /** Machines that couldn't be reached while signing out (AC-10.12). */
  left?: string[]
}

export function Gate({ children, machine = '', onUnavailable, left = [] }: GateProps) {
  const [gate, setGate] = useState<GateState>('checking')

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const run = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      void check(machine).then((c) => {
        if (stopped) return
        if (machine && c !== 'ok') {
          onUnavailable?.(c)
          return
        }
        if (c === 'unreachable') {
          setGate((g) => (g === 'checking' || g === 'offline' ? 'offline' : g))
          // Unreachable at startup: keep trying, like a reconnect would (ADR-0049 §3)
          timer = setTimeout(run, GATE_RETRY_MS)
          return
        }
        // A revoked device's cookie gets code "revoked" (AC-1.11): say so, as when revoked mid-use
        const next: GateState = c === 'ok' ? 'authed' : c
        setGate((g) => (g === 'checking' || g === 'offline' ? next : g))
      })
    }
    run()
    addEventListener('online', run)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      removeEventListener('online', run)
    }
  }, [machine])

  if (gate === 'checking') return <Skeleton offline={false} />
  if (gate === 'offline') return <Skeleton offline />
  if (gate === 'authed')
    return (
      <>
        {children(
          () => (machine ? onUnavailable?.('revoked') : setGate('revoked')),
          () => setGate('signedOut'),
        )}
      </>
    )
  return <Unpaired revoked={gate === 'revoked'} signedOut={gate === 'signedOut'} left={left} />
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

/**
 * Pairing instructions. When revoked or signed out, adds a line saying so, and after
 * signing out names the machines that couldn't be reached (AC-10.12).
 */
export function Unpaired({ revoked = false, signedOut = false, left = [] }: { revoked?: boolean; signedOut?: boolean; left?: string[] }) {
  return (
    <main class="gate" data-testid="unpaired">
      <h1>Pairing required</h1>
      {revoked && (
        <p class="error" data-testid="revoked">
          This device has been revoked.
        </p>
      )}
      {signedOut && <p data-testid="signed-out">Signed out.</p>}
      {signedOut && left.length > 0 && (
        <p class="error" data-testid="signed-out-left">
          Still signed in on {left.map((o) => o.replace(/^https?:\/\//, '')).join(', ')}
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
