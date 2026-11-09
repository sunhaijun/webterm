/**
 * The page's top level with several machines (ADR-0062 §2, §7–§11): which machine the app
 * talks to, the list, and adding, removing and signing out. The gate checks the current
 * machine, and the app is rebuilt for each one (keyed by its origin), as on a page load.
 */
import { useMemo, useRef, useState } from 'preact/hooks'

import { App } from '../app/app'
import { TextPages } from '../keys/textpage'
import { Gate } from '../ui/gate'
import { check, leave, pairWith } from './client'
import type { MachineCtx, Repair } from './context'
import { setMachineBase } from './current'
import { hostPort, machineNames, readCurrent, readMachines, writeCurrent, writeMachines } from './machines'

export function Root() {
  const own = location.origin
  const [list, setList] = useState(() => readMachines(own))
  const [current, setCurrent] = useState(() => readCurrent(own, readMachines(own)))
  const [repair, setRepair] = useState<Repair | null>(null)
  const [left, setLeft] = useState<string[]>([])
  const pages = useRef(new Map<string, TextPages>()).current
  /** Machines this device is signing out of: their revocation isn't news (ADR-0062 §10). */
  const leaving = useRef(new Set<string>()).current

  // Before the gate and the app render: every request they make goes to this machine
  setMachineBase(current)

  const names = useMemo(() => machineNames([own, ...list]), [own, list])
  const nameOf = (o: string) => names.get(o) ?? hostPort(o)

  const switchTo = (o: string) => {
    writeCurrent(o, own)
    setCurrent(o)
  }

  const store = (next: string[]) => {
    writeMachines(next)
    setList(next)
  }

  // Another machine is unusable: back to the page's own, offering to pair again if it signed us out (§7, §9)
  const unavailable = (from: string, why: 'unpaired' | 'revoked' | 'unreachable') => {
    switchTo(own)
    if (why === 'unreachable' || leaving.has(from)) return
    setRepair({ origin: from, message: why === 'revoked' ? `This device was revoked on ${nameOf(from)}` : `Pairing required on ${nameOf(from)}` })
  }

  let textPages = pages.get(current)
  if (!textPages) {
    textPages = new TextPages()
    pages.set(current, textPages)
  }

  const ctx: MachineCtx = {
    own,
    current,
    list,
    names,
    pages: textPages,
    repair,
    clearRepair: () => setRepair(null),
    switchTo,
    add: async (origin, digits) => {
      const err = await pairWith(origin, digits)
      if (err) return err
      leaving.delete(origin)
      store(list.includes(origin) ? list : [...list, origin])
      setRepair(null)
      switchTo(origin)
      return null
    },
    remove: async (origin, force) => {
      leaving.add(origin)
      if (!force) {
        const r = await leave(origin)
        if (r !== 'done') {
          leaving.delete(origin)
          return r
        }
      }
      store(list.filter((o) => o !== origin))
      if (current === origin) switchTo(own)
      return 'done'
    },
    signOut: async () => {
      // The page's own machine must answer, or nothing changes (§11, ADR-0048 §4)
      if ((await check('')) === 'unreachable') throw new Error('unreachable')
      const notReached: string[] = []
      for (const o of list) {
        leaving.add(o)
        if ((await leave(o)) !== 'done') notReached.push(o)
      }
      setLeft(notReached)
      const r = await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
      return r.status
    },
  }

  const machine = current === own ? '' : current
  return (
    <Gate key={current} machine={machine} onUnavailable={(why) => unavailable(current, why)} left={left}>
      {(revoke, signedOut) => <App key={current} onRevoked={revoke} onSignedOut={signedOut} machines={ctx} />}
    </Gate>
  )
}
