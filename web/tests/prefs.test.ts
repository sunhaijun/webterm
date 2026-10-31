/**
 * UT-prefs-1：两项偏好的读写（AC-5.3，ADR-0037）。控制器那一半在 controller.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GEAR, gearPath } from '../src/ui/icons'
import {
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  FONT_SIZE_KEY,
  THEME_KEY,
  applyTheme,
  readFontSize,
  readTheme,
  validFontSize,
  writeFontSize,
  writeTheme,
} from '../src/ui/prefs'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('UT-prefs-1 主题', () => {
  it('默认跟随系统；只认 light / dark，别的值当跟随系统', () => {
    expect(readTheme()).toBe('system')
    localStorage.setItem(THEME_KEY, 'dark')
    expect(readTheme()).toBe('dark')
    localStorage.setItem(THEME_KEY, 'purple')
    expect(readTheme()).toBe('system')
  })

  it('浅色 / 深色打上 data-theme，跟随系统时去掉', () => {
    const root = document.documentElement
    applyTheme('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(root.getAttribute('data-theme')).toBe('light')
    applyTheme('system')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('写进去读得回来', () => {
    writeTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(readTheme()).toBe('light')
  })
})

describe('UT-prefs-1 字号', () => {
  it('默认 14，范围 10–24', () => {
    expect(FONT_DEFAULT).toBe(14)
    expect(FONT_MIN).toBe(10)
    expect(FONT_MAX).toBe(24)
    expect(readFontSize()).toBe(14)
  })

  it('只收 10–24 的整数，别的回默认', () => {
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

  it('只有一份，不按形态分；老版本按形态存的 key 不读', () => {
    localStorage.setItem('webterm.fontSize.compact', '20')
    localStorage.setItem('webterm.fontSize.wide', '22')
    expect(readFontSize()).toBe(14)
  })
})

describe('UT-prefs-1 存储不可用', () => {
  it('localStorage 抛异常：读出默认值，写也不抛', () => {
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
  })
})

describe('线条图标（layout.md §图标）', () => {
  it('齿轮连同 1.75px 的描边整个落在 14×14 的框里', () => {
    expect(GEAR).toBe(gearPath())
    const nums = [...GEAR.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]))
    // 绝对坐标点：M / L / A 的终点；粗查所有数都不越界即可（弧的半径、标志位都在范围内）
    for (const n of nums) {
      expect(n).toBeGreaterThanOrEqual(-3.8) // 圆孔用相对坐标 a…，有负数
      expect(n).toBeLessThanOrEqual(14 - 1.75 / 2)
    }
    expect(GEAR.startsWith('M')).toBe(true)
    expect(GEAR).toContain('Z')
  })
})
