/**
 * Row actions on a sheet's list (ADR-0039 §1): swipe a row left, long-press it or
 * right-click it to slide it open over its buttons; one row open at a time. Shared by the
 * session drawer and the file list (ADR-0059 §3), so both behave the same.
 *
 * The hook owns the gesture state; the list renders rows with `row(key)` on the sliding
 * element, `click()` in its click handler and `act(fn)` on each button.
 */
import { useRef, useState } from 'preact/hooks'

import { PressTracker } from './longpress'
import { capturePointer } from './pointer'
import { RowSwipe } from './rowswipe'

interface Gesture<K> {
  key: K
  row: HTMLElement
  /** Swallow the click after this gesture (it swiped or long-pressed). */
  swallow: boolean
}

export interface RowHandlers {
  onPointerDown(e: PointerEvent): void
  onPointerMove(e: PointerEvent): void
  onPointerUp(): void
  onPointerCancel(): void
  onContextMenu(e: MouseEvent): void
}

export interface RowGestures<K> {
  /** The open row, if any. */
  open: K | null
  setOpen(key: K | null): void
  /** On the list (capture phase): a new press clears a leftover swallow flag. */
  onListPointerDown(): void
  row(key: K): RowHandlers
  /** In the row's click handler: false when the click must do nothing (it ended a swipe or long-press, or only closed the open row). */
  click(): boolean
  /** A row button's click handler. */
  act(fn: () => void): (e: MouseEvent) => void
}

/** `width`: the buttons' total width, as in CSS `--row-actions`. */
export function useRowGestures<K>(width: number): RowGestures<K> {
  // Only one press at a time, so the whole list shares one tracker
  const press = useRef(new PressTracker()).current
  const swipe = useRef(new RowSwipe(width)).current
  const gesture = useRef<Gesture<K> | null>(null)
  const swallowClick = useRef(false)
  const [open, setOpen] = useState<K | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  /**
   * Swallows the click the browser synthesizes after a swipe or long-press. This matters
   * most for long-press: once the row slides open, a button sits under the finger and the
   * synthesized click would hit it. The flag is cleared on the next press so that, when no
   * click is synthesized, the next real click isn't eaten.
   */
  const takeSwallow = () => {
    const s = swallowClick.current
    swallowClick.current = false
    return s
  }

  const row = (key: K): RowHandlers => ({
    onPointerDown(e) {
      if (e.button !== 0 || (e.target as Element).closest('.row-grip')) return
      const el = e.currentTarget as HTMLElement
      swipe.start(e.clientX, e.clientY, openRef.current === key)
      gesture.current = { key, row: el, swallow: false }
      press.down(e.clientX, e.clientY, () => {
        // Long-press opens the row, same as a swipe
        if (gesture.current) gesture.current.swallow = true
        setOpen(key)
      })
    },
    onPointerMove(e) {
      if (e.buttons === 0) return // Nothing pressed (mouse hover): not a gesture
      press.move(e.clientX, e.clientY)
      const g = gesture.current
      if (!g) return
      const off = swipe.move(e.clientX, e.clientY)
      if (off === null) return
      if (!g.swallow) {
        g.swallow = true
        press.cancel()
        capturePointer(g.row, e.pointerId)
        if (openRef.current !== null && openRef.current !== g.key) setOpen(null)
      }
      g.row.style.transition = 'none'
      g.row.style.transform = `translateX(${off}px)`
    },
    onPointerUp() {
      press.up()
      const g = gesture.current
      gesture.current = null
      const res = swipe.end()
      if (!g) return
      g.row.style.transition = ''
      g.row.style.transform = '' // data-open (CSS) decides where it rests, with a transition
      if (res) setOpen(res === 'open' ? g.key : openRef.current === g.key ? null : openRef.current)
      if (g.swallow) swallowClick.current = true
    },
    onPointerCancel() {
      press.cancel()
      swipe.end()
      const g = gesture.current
      gesture.current = null
      if (g) {
        g.row.style.transition = ''
        g.row.style.transform = ''
      }
    },
    onContextMenu(e) {
      e.preventDefault()
      setOpen(key)
    },
  })

  return {
    open,
    setOpen,
    onListPointerDown: () => {
      swallowClick.current = false
    },
    row,
    click: () => {
      if (takeSwallow()) return false
      // A row is open: any click just closes it
      if (openRef.current !== null) {
        setOpen(null)
        return false
      }
      return true
    },
    act: (fn) => (e) => {
      e.stopPropagation()
      if (takeSwallow()) return
      setOpen(null)
      fn()
    },
  }
}
