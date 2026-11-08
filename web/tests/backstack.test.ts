import { describe, expect, it } from 'vitest'

import { BackStack, type HistoryLike } from '../src/ui/backstack'

/** A history with a cursor, firing popstate like a browser does for go(). */
class FakeHistory implements HistoryLike {
  entries = 1
  index = 0
  goes: number[] = []
  onPop: () => void = () => {}
  pushState(): void {
    this.entries = this.index + 2 // forward entries are dropped
    this.index++
  }
  go(delta: number): void {
    this.goes.push(delta)
    this.index = Math.max(0, this.index + delta)
    this.onPop()
  }
  /** The user pressed Back. */
  back(): void {
    this.go(-1)
    this.goes.pop()
  }
}

function setup() {
  const h = new FakeHistory()
  const queue: Array<() => void> = []
  const stack = new BackStack(h, (fn) => queue.push(fn))
  h.onPop = () => stack.onPop()
  const flush = () => queue.splice(0).forEach((fn) => fn())
  const closed: string[] = []
  /** Opens a sheet; its close() unmounts it, which releases its entry, like Drawer does. */
  const open = (name: string) => {
    let release = () => {}
    const sheet = {
      close: () => {
        closed.push(name)
        release()
      },
    }
    release = stack.push(() => sheet.close())
    return sheet
  }
  return { h, stack, flush, closed, open }
}

describe('UT-backstack-1 (AC-9.11)', () => {
  it('Back closes only the top sheet, then the next', () => {
    const { h, stack, closed, open } = setup()
    open('list')
    open('file')
    expect(h.index).toBe(2)
    h.back()
    expect(closed).toEqual(['file'])
    expect(stack.depth).toBe(1)
    h.back()
    expect(closed).toEqual(['file', 'list'])
    expect(h.index).toBe(0)
    expect(h.goes).toEqual([])
  })

  it('closing a sheet another way removes its entry and the sheet below stays', () => {
    const { h, stack, flush, closed, open } = setup()
    open('list')
    const file = open('file')
    file.close() // ✕
    flush()
    expect(h.goes).toEqual([-1])
    expect(closed).toEqual(['file']) // our own popstate didn't close the list
    expect(stack.depth).toBe(1)
    expect(h.index).toBe(1)
  })

  it('sheets closed together leave with one go(-n)', () => {
    const { h, stack, flush, open } = setup()
    const list = open('list')
    const file = open('file')
    file.close()
    list.close() // Send to session closes both in one render
    flush()
    expect(h.goes).toEqual([-2])
    expect(h.index).toBe(0)
    expect(stack.depth).toBe(0)
  })

  it('opening and closing over and over never piles up entries', () => {
    const { h, flush, open } = setup()
    for (let i = 0; i < 5; i++) {
      open('list').close()
      flush()
    }
    expect(h.entries).toBeLessThanOrEqual(2)
    expect(h.index).toBe(0)
  })

  it('closing one sheet as another opens keeps the depth right', () => {
    const { h, stack, flush, closed, open } = setup()
    const drawer = open('drawer')
    drawer.close() // the session drawer closes as the file list opens, in one click
    open('list')
    flush()
    expect(stack.depth).toBe(1)
    expect(h.index).toBe(1)
    h.back()
    expect(closed).toEqual(['drawer', 'list'])
    expect(h.index).toBe(0)
  })
})

describe('UT-backstack-1 the real defer', () => {
  it('the default defer works unbound (queueMicrotask needs its global this)', async () => {
    const goes: number[] = []
    const stack = new BackStack({ pushState: () => {}, go: (d) => goes.push(d) })
    stack.push(() => {})()
    await Promise.resolve()
    expect(goes).toEqual([-1])
  })
})
