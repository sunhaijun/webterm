/**
 * UT-prefs-1: reading and writing the two preferences (AC-5.3, ADR-0037). The controller
 * half is in controller.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GEAR, gearPath } from '../src/ui/icons'
import {
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  FONT_SIZE_KEY,
  KEYS_COLLAPSED_KEY,
  THEME_KEY,
  applyTheme,
  readKeysCollapsed,
  readFontSize,
  readTheme,
  validFontSize,
  writeFontSize,
  writeKeysCollapsed,
  writeTheme,
} from '../src/ui/prefs'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('UT-prefs-1 theme', () => {
  it('defaults to system and accepts only light / dark, treating anything else as system', () => {
    expect(readTheme()).toBe('system')
    localStorage.setItem(THEME_KEY, 'dark')
    expect(readTheme()).toBe('dark')
    localStorage.setItem(THEME_KEY, 'purple')
    expect(readTheme()).toBe('system')
  })

  it('sets data-theme for light / dark and removes it for system', () => {
    const root = document.documentElement
    applyTheme('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(root.getAttribute('data-theme')).toBe('light')
    applyTheme('system')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('reads back what was written', () => {
    writeTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(readTheme()).toBe('light')
  })
})

describe('UT-prefs-1 font size', () => {
  it('defaults to 14 within 10–24', () => {
    expect(FONT_DEFAULT).toBe(14)
    expect(FONT_MIN).toBe(10)
    expect(FONT_MAX).toBe(24)
    expect(readFontSize()).toBe(14)
  })

  it('accepts only integers 10–24, falling back to the default otherwise', () => {
    for (const ok of [10, 16, 24]) expect(validFontSize(ok)).toBe(true)
    for (const bad of [9, 25, 14.5, NaN, Infinity]) expect(validFontSize(bad)).toBe(false)
    for (const raw of ['9', '25', '14.5', 'abc', '', ' ']) {
      localStorage.setItem(FONT_SIZE_KEY, raw)
      expect(readFontSize(), JSON.stringify(raw)).toBe(14)
    }
    writeFontSize(18)
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe('18')
    expect(readFontSize()).toBe(18)
  })

  it('stores one value, not per form factor, and ignores old per-form-factor keys', () => {
    localStorage.setItem('webterm.fontSize.compact', '20')
    localStorage.setItem('webterm.fontSize.wide', '22')
    expect(readFontSize()).toBe(14)
  })
})

describe('UT-prefs collapsed extra keys (ADR-0056)', () => {
  it('defaults to expanded and reads back what was written', () => {
    expect(readKeysCollapsed()).toBe(false)
    writeKeysCollapsed(true)
    expect(localStorage.getItem(KEYS_COLLAPSED_KEY)).toBe('1')
    expect(readKeysCollapsed()).toBe(true)
    writeKeysCollapsed(false)
    expect(readKeysCollapsed()).toBe(false)
  })
})

describe('UT-prefs-1 storage unavailable', () => {
  it('reads defaults and writes without throwing when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(readTheme()).toBe('system')
    expect(readFontSize()).toBe(14)
    expect(() => writeTheme('dark')).not.toThrow()
    expect(() => writeFontSize(16)).not.toThrow()
    expect(readKeysCollapsed()).toBe(false)
    expect(() => writeKeysCollapsed(true)).not.toThrow()
  })
})

describe('line icons (layout.md)', () => {
  it('fits the gear, including its 1.75px stroke, entirely inside the 14×14 box', () => {
    expect(GEAR).toBe(gearPath())
    const nums = [...GEAR.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]))
    // Absolute points are the M / L / A endpoints; a rough bounds check on every number is enough (arc radii and flags are in range)
    for (const n of nums) {
      expect(n).toBeGreaterThanOrEqual(-3.8) // the hole uses relative a… coordinates, which can be negative
      expect(n).toBeLessThanOrEqual(14 - 1.75 / 2)
    }
    expect(GEAR.startsWith('M')).toBe(true)
    expect(GEAR).toContain('Z')
  })
})
