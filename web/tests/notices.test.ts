/** Connection status text (AC-2.10, session-ux.md §Connection status). */
import { describe, expect, it } from 'vitest'

import { formatBytes } from '../src/app/controller'
import { connLabel } from '../src/app/notices'

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
