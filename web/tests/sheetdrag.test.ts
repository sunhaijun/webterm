/**
 * UT-sheetdrag-1: dragging a bottom sheet (AC-9.16, ADR-0066 §1). Where a released sheet lands,
 * and which touches move it: the handle and header always, the body down only from the top and
 * never up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CLOSE_PX, installSheetDrag, REST, settle, SNAP_PX } from '../src/ui/swipe'

describe('UT-sheetdrag-1 settle', () => {
  it('a one-height sheet closes only past the close distance', () => {
    expect(settle(400 - CLOSE_PX, 400, 400, false)).toBe('rest')
    expect(settle(400 - CLOSE_PX - 1, 400, 400, false)).toBe('close')
    expect(settle(400, 400, 400, false)).toBe('rest')
  })

  it('from 80%: up past the snap distance goes full, less settles back, far down closes', () => {
    expect(settle(800 + SNAP_PX, 800, 1000, false)).toBe('rest')
    expect(settle(800 + SNAP_PX + 1, 800, 1000, false)).toBe('full')
    expect(settle(1000, 800, 1000, false)).toBe('full')
    expect(settle(800 - CLOSE_PX - 1, 800, 1000, false)).toBe('close')
  })

  it('from full: down past the snap distance goes to 80%, past the 80% line by the close distance closes', () => {
    expect(settle(1000 - SNAP_PX, 800, 1000, true)).toBe('full')
    expect(settle(1000 - SNAP_PX - 1, 800, 1000, true)).toBe('rest')
    expect(settle(800 - CLOSE_PX, 800, 1000, true), 'just above the line').toBe('rest')
    expect(settle(800 - CLOSE_PX - 1, 800, 1000, true), 'one long swipe').toBe('close')
  })
})

/** One finger at y; touches is empty on touchend. */
function finger(el: Element, type: string, y: number, x = 50): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const pts = [{ clientX: x, clientY: y }]
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : pts })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  el.dispatchEvent(ev)
  return ev
}

function drag(el: Element, dy: number, dx = 0) {
  finger(el, 'touchstart', 500)
  for (let i = 1; i <= 5; i++) finger(el, 'touchmove', 500 + (dy * i) / 5, 50 + (dx * i) / 5)
  finger(el, 'touchend', 500 + dy, 50 + dx)
}

describe('UT-sheetdrag-1 installSheetDrag', () => {
  const VISIBLE = 1000
  let backdrop: HTMLElement
  let sheet: HTMLElement
  let head: HTMLElement
  let body: HTMLElement
  let max: { on: boolean; toggle(): void } | undefined
  let dismissed: number
  let uninstall: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div class="drawer-backdrop"><div class="drawer"><div class="drawer-grab"></div><div class="drawer-head"><button>x</button></div><div class="drawer-body"></div></div></div>'
    backdrop = document.querySelector('.drawer-backdrop')!
    sheet = document.querySelector('.drawer')!
    head = document.querySelector('.drawer-head')!
    body = document.querySelector('.drawer-body')!
    Object.defineProperty(backdrop, 'clientHeight', { value: VISIBLE })
    // jsdom has no layout: the sheet is as tall as its two heights say, or its inline height while dragged
    sheet.getBoundingClientRect = () => ({ height: sheet.style.height ? parseFloat(sheet.style.height) : max?.on ? VISIBLE : VISIBLE * REST }) as DOMRect
    max = {
      on: false,
      toggle() {
        this.on = !this.on
      },
    }
    dismissed = 0
    uninstall = installSheetDrag(sheet, { enabled: () => true, onDismiss: () => dismissed++, max: () => max })
  })
  afterEach(() => {
    uninstall()
    vi.useRealTimers()
  })

  it('the header pulls an 80% sheet up and follows the finger; released past the snap distance it is full', () => {
    finger(head, 'touchstart', 500)
    finger(head, 'touchmove', 480)
    finger(head, 'touchmove', 400)
    expect(sheet.style.height).toBe('900px')
    finger(head, 'touchmove', 100)
    expect(sheet.style.height, 'no higher than the visible area').toBe('1000px')
    finger(head, 'touchend', 100)
    expect(max!.on).toBe(true)
    vi.advanceTimersByTime(200)
    expect(sheet.style.height, 'CSS holds the height again').toBe('')
  })

  it('a short pull settles back; the grab handle pulls too', () => {
    drag(document.querySelector('.drawer-grab')!, -30)
    expect(max!.on).toBe(false)
    drag(document.querySelector('.drawer-grab')!, -60)
    expect(max!.on).toBe(true)
  })

  it('up on the body scrolls: the sheet is left alone and the move not cancelled', () => {
    finger(body, 'touchstart', 500)
    const ev = finger(body, 'touchmove', 400)
    finger(body, 'touchend', 400)
    expect(ev.defaultPrevented).toBe(false)
    expect(sheet.style.height).toBe('')
    expect(max!.on).toBe(false)
  })

  it('down from full: the header works with the body scrolled, to 80% or, further, closed', () => {
    max!.on = true
    body.scrollTop = 300
    drag(body, 100)
    expect(max!.on, 'the scrolled body scrolls').toBe(true)
    drag(head, 100)
    expect(max!.on).toBe(false)
    max!.on = true
    drag(head, VISIBLE * (1 - REST) + CLOSE_PX + 10)
    vi.advanceTimersByTime(200)
    expect(dismissed).toBe(1)
  })

  it('a sheet with one height only slides down, from the body once it is at the top', () => {
    max = undefined
    drag(head, -200)
    expect(sheet.style.height).toBe('')
    finger(body, 'touchstart', 500)
    finger(body, 'touchmove', 560)
    expect(sheet.style.transform).toBe('translateY(60px)')
    expect(sheet.style.height, 'no height set').toBe('')
    finger(body, 'touchend', 560)
    vi.advanceTimersByTime(200)
    expect(dismissed).toBe(0)
    drag(body, CLOSE_PX + 10)
    vi.advanceTimersByTime(200)
    expect(dismissed).toBe(1)
  })

  it('sideways belongs to rows and the path', () => {
    drag(head, -10, -80)
    expect(max!.on).toBe(false)
    expect(sheet.style.height).toBe('')
  })
})
