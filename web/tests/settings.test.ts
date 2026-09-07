/** 主题与字号的持久化（AC-5.3）。 */
import { beforeEach, describe, expect, it } from 'vitest'

import { applyTheme, readFontSize, readTheme, writeFontSize } from '../src/ui/settings'

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

describe('字号按断点分别记', () => {
  it('各断点有独立的默认值与存储', () => {
    writeFontSize(18, 390) // phone
    writeFontSize(12, 1440) // desktop
    expect(readFontSize(390)).toBe(18)
    expect(readFontSize(1440)).toBe(12)
    // 没设过的断点走默认值
    expect(readFontSize(800)).toBe(14)
  })

  it('越界的值被忽略，回落到默认', () => {
    localStorage.setItem('webterm.font.desktop', '999')
    expect(readFontSize(1440)).toBe(14)
    localStorage.setItem('webterm.font.desktop', 'not-a-number')
    expect(readFontSize(1440)).toBe(14)
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
    expect(() => writeFontSize(16)).not.toThrow()
    expect(readFontSize(1440)).toBe(14)
    if (orig) Object.defineProperty(window, 'localStorage', orig)
  })
})
