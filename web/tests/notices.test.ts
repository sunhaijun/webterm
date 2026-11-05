/** Connection status text and banner (AC-2.10, session-ux.md §Connection status, ADR-0049). */
import { h, render } from 'preact'
import { afterEach, describe, expect, it } from 'vitest'

import { formatBytes, type ConnNote } from '../src/app/controller'
import { ConnBanner, connLabel } from '../src/app/notices'

describe('conn-text', () => {
  it('says just "Online" when online (the RTT goes in the wide status dot title, not conn-text)', () => {
    expect(connLabel('online', {})).toBe('Online')
    expect(connLabel('online', { rttMs: 900 })).toBe('Online')
  })
  it('shows a countdown while reconnecting (rounded up to seconds)', () => {
    expect(connLabel('reconnecting', { retryInMs: 2100 })).toBe('Reconnecting · retry in 3s')
    expect(connLabel('reconnecting', { retryInMs: 0 })).toBe('Reconnecting · retry in 0s')
    expect(connLabel('reconnecting', {})).toBe('Reconnecting…')
  })
  it('never says Online in other states', () => {
    expect(connLabel('connecting', {})).toBe('Connecting…')
    expect(connLabel('closed', {})).toBe('Disconnected')
  })
})

describe('byte counts in "Resumed · caught up N KB"', () => {
  it('B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(48 * 1024)).toBe('48.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

// UT-connbanner-1: every connection message is in the banner (ADR-0049).
describe('UT-connbanner-1 connection banner', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })
  const show = (state: 'online' | 'reconnecting', note: ConnNote | null) => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    render(h(ConnBanner, { state, info: state === 'reconnecting' ? { retryInMs: 3000 } : {}, fatal: null, note }), el)
    const banner = el.querySelector<HTMLElement>('[data-testid="conn-banner"]')!
    return {
      hidden: banner.classList.contains('sr-only'),
      tone: banner.dataset.note,
      text: el.querySelector('[data-testid="conn-text"]')!,
      note: el.querySelector('[data-testid="conn-note"]')?.textContent ?? null,
    }
  }

  it('is hidden while online without a note; conn-text stays in the DOM', () => {
    const b = show('online', null)
    expect(b.hidden).toBe(true)
    expect(b.text.textContent).toBe('Online')
  })

  it('shows a note alone once online, in the note color; the state text stays visually hidden', () => {
    const b = show('online', { id: 1, kind: 'ok', text: 'Resumed · caught up 2 KB' })
    expect(b.hidden).toBe(false)
    expect(b.tone).toBe('ok')
    expect(b.note).toBe('Resumed · caught up 2 KB')
    expect(b.text.classList.contains('sr-only')).toBe(true)
  })

  it('shows a refusal next to the state while reconnecting', () => {
    const b = show('reconnecting', { id: 2, kind: 'warn', text: "Can't create a session until reconnected" })
    expect(b.hidden).toBe(false)
    expect(b.text.textContent).toBe('Reconnecting · retry in 3s')
    expect(b.text.classList.contains('sr-only')).toBe(false)
    expect(b.note).toBe("Can't create a session until reconnected")
  })
})
