/** UT-font-1（字号部分）：主题与字号的持久化 —— 字号按形态各存一份（AC-5.3）。 */
import { beforeEach, describe, expect, it } from 'vitest'

import { FONT_DEFAULT, applyTheme, fontSizeKey, readFontSize, readTheme, validFontSize, writeFontSize } from '../src/ui/prefs'

beforeEach(() => localStorage.clear())

describe('主题三态', () => {
  it('默认跟随系统', () => {
    expect(readTheme()).toBe('system')
  })

  it('跟随系统时不打标记，靠 prefers-color-scheme', () => {
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('强制浅色/深色时打标记，让手动切换在两个方向都生效', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('选择被记住', () => {
    applyTheme('dark')
    expect(readTheme()).toBe('dark')
  })
})

describe('字号按形态分别记', () => {
  it('compact / wide 各一份，键名是 webterm.fontSize.<形态>', () => {
    expect(fontSizeKey('compact')).toBe('webterm.fontSize.compact')
    expect(fontSizeKey('wide')).toBe('webterm.fontSize.wide')
    writeFontSize('compact', 18)
    expect(localStorage.getItem('webterm.fontSize.compact')).toBe('18')
    expect(readFontSize('compact')).toBe(18)
    // 没设过的形态走默认 14
    expect(readFontSize('wide')).toBe(FONT_DEFAULT)
    expect(FONT_DEFAULT).toBe(14)
  })

  it('范围 8–32 的整数，越界或乱写的值回落到默认', () => {
    expect(validFontSize(8)).toBe(true)
    expect(validFontSize(32)).toBe(true)
    expect(validFontSize(7)).toBe(false)
    expect(validFontSize(33)).toBe(false)
    expect(validFontSize(14.5)).toBe(false)
    localStorage.setItem('webterm.fontSize.wide', '999')
    expect(readFontSize('wide')).toBe(14)
    localStorage.setItem('webterm.fontSize.wide', 'not-a-number')
    expect(readFontSize('wide')).toBe(14)
  })

  it('老的按断点存的键不再被读', () => {
    localStorage.setItem('webterm.font.phone', '20')
    expect(readFontSize('compact')).toBe(14)
  })
})

describe('localStorage 不可用时不能崩', () => {
  it('读写都要能兜住异常', () => {
    // 隐私窗口 / 禁用站点数据时 localStorage 的存取会直接抛
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(() => readTheme()).not.toThrow()
    expect(() => writeFontSize('wide', 16)).not.toThrow()
    expect(readFontSize('wide')).toBe(14)
    if (orig) Object.defineProperty(window, 'localStorage', orig)
  })
})
