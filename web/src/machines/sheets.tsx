/**
 * The machine button and the Machines sheets (ADR-0062 §8, session-ux.md §Machines).
 *
 * - `MachineButton`: the session drawer's title on `compact`, the tab bar's first item on
 *   `wide`: the current machine's name and a chevron.
 * - `MachinesSheet`: one row per machine, the page's own first; tap to switch; swipe left or
 *   long-press a row (not the own one) for Remove, as session rows (ADR-0039).
 * - `AddMachineSheet`: an address and the 16 digits from that machine's `webterm pair`.
 * - `RemoveMachineConfirm`: the machine couldn't be reached; remove it anyway?
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import { Drawer } from '../ui/drawer'
import { ChevronDownIcon, PlusIcon } from '../ui/icons'
import { PAIR_DIGITS_LEN, formatPairDigits, normalizePairDigits } from '../ui/paircode'
import { useRowGestures } from '../ui/rowgestures'
import { ROW_ACT_PX } from '../ui/rowswipe'
import { hostPort, parseAddress } from './machines'

export function MachineButton({ name, onOpen }: { name: string; onOpen(): void }) {
  return (
    <button type="button" class="machine-btn" data-testid="machine-button" aria-label={`Machine ${name}`} title={name} onClick={onOpen}>
      <span class="machine-name">{name}</span>
      <ChevronDownIcon />
    </button>
  )
}

export interface MachinesSheetProps {
  own: string
  current: string
  list: string[]
  names: Map<string, string>
  onPick(origin: string): void
  onRemove(origin: string): void
  onAdd(): void
  onClose(): void
}

export function MachinesSheet(p: MachinesSheetProps) {
  const rows = useRowGestures<string>(ROW_ACT_PX)
  const all = [p.own, ...p.list]
  return (
    <Drawer
      title="Machines"
      testid="machines-sheet"
      backdropTestid="machines-backdrop"
      variant="machines"
      backButton
      onClose={p.onClose}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn drawer-new" data-testid="machine-add" onClick={p.onAdd}>
            <PlusIcon />
            Add machine
          </button>
        </div>
      }
    >
      <ul class="session-list machine-list" data-testid="machine-list" onPointerDownCapture={rows.onListPointerDown}>
        {all.map((o) => {
          const own = o === p.own
          const open = rows.open === o
          return (
            <li key={o} class="sl-item" data-open={open ? 'true' : 'false'}>
              {!own && (
                <div class="row-actions" aria-hidden={open ? undefined : 'true'}>
                  <button
                    type="button"
                    class="row-act"
                    data-act="close"
                    data-testid="machine-row-remove"
                    tabIndex={open ? 0 : -1}
                    onClick={rows.act(() => p.onRemove(o))}
                  >
                    Remove
                  </button>
                </div>
              )}
              <div
                class="session-row machine-row"
                role="button"
                tabIndex={0}
                data-testid="machine-row"
                data-origin={o}
                aria-current={o === p.current ? 'true' : undefined}
                title={o}
                {...(own ? {} : rows.row(o))}
                onClick={() => {
                  if (rows.click()) p.onPick(o)
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    p.onPick(o)
                  }
                }}
              >
                <span class="sl-name">
                  <span class="sl-text">{p.names.get(o) ?? hostPort(o)}</span>
                </span>
                <span class="sl-meta machine-host">
                  <bdi dir="ltr">{hostPort(o)}</bdi>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </Drawer>
  )
}

export interface AddMachineSheetProps {
  /** Filled in when the page reopens a machine that signed this device out (ADR-0062 §9). */
  address?: string
  error?: string
  /** Origins already listed (refused as duplicates). */
  existing: string[]
  onAdd(origin: string, digits: string): Promise<string | null>
  onCancel(): void
}

export function AddMachineSheet(p: AddMachineSheetProps) {
  const [address, setAddress] = useState(p.address ?? '')
  const [digits, setDigits] = useState('')
  const [error, setError] = useState(p.error ?? '')
  const [busy, setBusy] = useState(false)
  const addrRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)

  // Drawer's layout effect runs first and pulls focus into the sheet; then put it where typing starts
  useLayoutEffect(() => {
    for (const el of [addrRef.current, codeRef.current]) {
      // setAttribute: in Chrome autocorrect is a boolean IDL attribute (AC-3.10)
      el?.setAttribute('autocorrect', 'off')
      el?.setAttribute('autocapitalize', 'off')
      el?.setAttribute('spellcheck', 'false')
    }
    ;(p.address ? codeRef.current : addrRef.current)?.focus({ preventScroll: true })
    return () => {
      alive.current = false
    }
  }, [])

  const ready = address.trim() !== '' && digits.length === PAIR_DIGITS_LEN && !busy
  const submit = async () => {
    if (!ready) return
    const parsed = parseAddress(address, location, p.existing)
    if ('error' in parsed) {
      setError(parsed.message)
      return
    }
    setBusy(true)
    setError('')
    const err = await p.onAdd(parsed.origin, digits)
    if (!alive.current) return // paired: the page has switched to the new machine
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <Drawer
      title="Add machine"
      testid="machine-add-sheet"
      backdropTestid="machine-add-backdrop"
      variant="rename"
      onClose={p.onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="machine-add-cancel" onClick={p.onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn primary" data-testid="machine-add-ok" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      }
    >
      <div class="rename-field machine-fields">
        <input
          ref={addrRef}
          class="rename-sheet-input"
          data-testid="machine-address"
          type="text"
          inputMode="url"
          autocomplete="off"
          placeholder="name.example.com"
          aria-label="Address"
          value={address}
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing) return
            e.preventDefault()
            codeRef.current?.focus()
          }}
        />
        <input
          ref={codeRef}
          class="rename-sheet-input pair-digits"
          data-testid="machine-code"
          type="text"
          inputMode="numeric"
          autocomplete="one-time-code"
          placeholder="1234-5678-9012-3456"
          aria-label="Pairing code"
          maxLength={PAIR_DIGITS_LEN + 3}
          value={formatPairDigits(digits)}
          onInput={(e) => setDigits(normalizePairDigits(e.currentTarget.value).slice(0, PAIR_DIGITS_LEN))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing) return
            e.preventDefault()
            void submit()
          }}
        />
        {error && (
          <p class="machine-error" data-testid="machine-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Drawer>
  )
}

export function RemoveMachineConfirm({ name, onOk, onCancel }: { name: string; onOk(): void; onCancel(): void }) {
  const okRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => okRef.current?.focus({ preventScroll: true }), [])
  return (
    <Drawer
      title={`Can't reach ${name}. Remove it anyway?`}
      testid="machine-remove-confirm"
      backdropTestid="machine-remove-backdrop"
      variant="confirm"
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="machine-remove-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn danger" data-testid="machine-remove-ok" ref={okRef} onClick={onOk}>
            Remove
          </button>
        </div>
      }
    >
      <p class="confirm-text">It stays signed in there.</p>
    </Drawer>
  )
}
