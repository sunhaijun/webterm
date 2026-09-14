/** UT-font-1：终端字体的清单、探测与持久化（AC-5.13，ADR-0023）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CJK_TAIL,
  FONT_CHOICES,
  SYSTEM_STACK,
  availableFonts,
  fontStack,
  readFontFamily,
  resetFontProbe,
  writeFontFamily,
  type Measure,
} from '../src/ui/fonts'

/** 三条通用族的基线宽度 —— 探测就是拿它们比出来的。 */
const BASE: Record<string, number> = { monospace: 100, serif: 110, 'sans-serif': 120 }

/**
 * 假量尺。`installed` 里的字体在**所有**基线上都换了宽度；
 * `sameAsMono` 里的只在 serif / sans-serif 上换 —— 模拟"它就是本机的默认等宽字体"。
 */
function measurer(installed: string[], sameAsMono: string[] = []): Measure {
  return (family) => {
    const m = /^"(.+?)", (.+)$/.exec(family)
    if (!m) return BASE[family] ?? 0
    const name = m[1]!
    const base = BASE[m[2]!] ?? 0
    if (sameAsMono.includes(name)) return m[2] === 'monospace' ? base : base + 7
    return installed.includes(name) ? base + 7 : base
  }
}

const ids = (list: { id: string }[]) => list.map((c) => c.id)

beforeEach(() => {
  localStorage.clear()
  resetFontProbe()
})

describe('清单', () => {
  it('每一项的 stack 都以 CJK 等宽 + monospace 收尾 —— 少了它中英混排会歪', () => {
    for (const c of FONT_CHOICES) {
      expect(c.stack.endsWith(CJK_TAIL), `${c.id} 的 stack 没有 CJK 尾巴：${c.stack}`).toBe(true)
    }
  })

  it('系统默认排第一，且它就是现在写死的那串', () => {
    expect(FONT_CHOICES[0]?.id).toBe('system')
    expect(FONT_CHOICES[0]?.stack).toBe(SYSTEM_STACK)
  })

  it('id 不重复', () => {
    expect(new Set(ids([...FONT_CHOICES])).size).toBe(FONT_CHOICES.length)
  })
})

describe('探测：只列本机装了的', () => {
  it('没装的不出现，装了的出现', () => {
    const list = availableFonts(measurer(['JetBrains Mono']))
    expect(ids(list)).toContain('jetbrains')
    expect(ids(list)).not.toContain('firacode')
  })

  it('系统默认永远在第一位，一个都没探到也在', () => {
    const list = availableFonts(measurer([]))
    expect(ids(list)).toEqual(['system'])
  })

  it('顺序按清单来，不按探测顺序', () => {
    const list = availableFonts(measurer(['Menlo', 'JetBrains Mono']))
    const order = ids([...FONT_CHOICES])
    expect(ids(list)).toEqual(ids(list).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  })

  it('【要害】本机默认等宽字体也要认出来 —— 只跟 monospace 比会漏掉它', () => {
    // Menlo 常常【就是】浏览器的默认 monospace：宽度一样，只比这一条会判成"没装"
    const list = availableFonts(measurer([], ['Menlo']))
    expect(ids(list)).toContain('menlo')
  })

  it('拿不到量尺（没有 canvas 2d 上下文）时退化成只有系统默认，不报错', () => {
    expect(ids(availableFonts(null))).toEqual(['system'])
  })

  it('一个页面只探一轮 —— 结果不会中途变，设置面板却可能开关很多次', () => {
    const first = measurer(['Hack'])
    const spy = vi.fn(first)
    availableFonts(spy)
    const calls = spy.mock.calls.length
    expect(calls).toBeGreaterThan(0)

    const second = vi.fn(measurer(['Iosevka']))
    const again = availableFonts(second)
    expect(second).not.toHaveBeenCalled()
    expect(ids(again)).toContain('hack')
    expect(spy.mock.calls.length, '第二次没有再量一遍').toBe(calls)
  })
})

describe('fontStack', () => {
  it('认得清单里的 id', () => {
    expect(fontStack('jetbrains')).toBe(`"JetBrains Mono", ${CJK_TAIL}`)
  })

  it('不认得的 id 回落系统默认 —— 清单改过之后老配置不能把终端搞没', () => {
    expect(fontStack('no-such-font')).toBe(SYSTEM_STACK)
    expect(fontStack('')).toBe(SYSTEM_STACK)
  })
})

describe('持久化', () => {
  it('默认是系统默认', () => {
    expect(readFontFamily()).toBe('system')
  })

  it('存的是 id，全局一份（不带断点后缀）', () => {
    writeFontFamily('jetbrains')
    expect(localStorage.getItem('webterm.font.family')).toBe('jetbrains')
    expect(readFontFamily()).toBe('jetbrains')
  })

  it('存进去的野值被忽略', () => {
    localStorage.setItem('webterm.font.family', 'comic-sans')
    expect(readFontFamily()).toBe('system')
  })

  it('localStorage 不可用时读写都不能崩', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(() => writeFontFamily('menlo')).not.toThrow()
    expect(readFontFamily()).toBe('system')
    if (orig) Object.defineProperty(window, 'localStorage', orig)
  })
})
