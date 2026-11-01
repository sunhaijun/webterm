/**
 * 浏览器的输出路径（ADR-0026 §7，layout.md §渲染）：
 *   UT-decode-1  流式 UTF-8 解码 —— 多字节字符被切在两帧之间也不丢字（AC-2.23）
 *   快照          RIS 在流内清屏、换新解码器、算回放（AC-2.6）
 *   本地提示行    排在输出之后；快照之前排下的作废（AC-4.5）
 */
import { describe, expect, it } from 'vitest'

import { FONT_FAMILY, SCROLLBACK, createTerminal, exitLine, proposeSize, themeFromCss } from '../src/term/terminal'
import { FONT_DEFAULT } from '../src/ui/prefs'
import { flush, lineText, lines } from './helpers'

const bytes = (...xs: number[]) => new Uint8Array(xs)
const enc = (s: string) => new TextEncoder().encode(s)
const mk = () => createTerminal(undefined, FONT_DEFAULT)

describe('UT-decode-1 切开的 UTF-8 不丢字', () => {
  it('。…— 各被切在第 2 字节之后、落在不同的 OUTPUT 帧里（E2E-43 的切法）', async () => {
    const h = mk()
    h.output(bytes(0xe3, 0x80), false)
    h.output(bytes(0x82, 0xe2, 0x80), false)
    h.output(bytes(0xa6, 0xe2, 0x80), false)
    h.output(new Uint8Array([0x94, ...enc('END\r\n')]), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('。…—END')
    h.dispose()
  })

  it('一个字节一帧也照样拼得回来（中文、emoji）', async () => {
    const h = mk()
    for (const b of enc('中文😀，“引号”、《书名》\r\n')) h.output(bytes(b), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('中文😀，“引号”、《书名》')
    h.dispose()
  })

  it('整帧都是半个字符时什么都不写，等下一帧', async () => {
    const h = mk()
    h.output(bytes(0xe4), false)
    h.output(bytes(0xb8), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('')
    h.output(bytes(0xad), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('中')
    h.dispose()
  })

  it('每个会话各有各的解码器：一个会话里的半个字符不会接到另一个会话上', async () => {
    const a = mk()
    const b = mk()
    a.output(bytes(0xe3, 0x80), false)
    b.output(enc('x'), false)
    a.output(bytes(0x82), false)
    await flush(a.term)
    await flush(b.term)
    expect(lineText(a.term, 0)).toBe('。')
    expect(lineText(b.term, 0)).toBe('x')
    a.dispose()
    b.dispose()
  })
})

describe('快照（AC-2.6）', () => {
  it('清屏后重画：旧内容只出现 0 次，快照内容只出现一份', async () => {
    const h = mk()
    h.output(enc('MARK-ONE\r\nold line\r\n'), false)
    await flush(h.term)
    h.snapshot(enc('restored\r\n$ '))
    await flush(h.term)
    expect(lines(h.term)).toEqual(['restored', '$ '])
    h.dispose()
  })

  it('清屏发生在流内：快照之前还没解析的旧输出不会被画到快照后面', async () => {
    const h = mk()
    // 不等它解析完就来快照（列数一变 agent 立刻重发快照，写缓冲里可能还排着旧输出）
    h.output(enc('stale-1\r\nstale-2\r\n'), false)
    h.snapshot(enc('fresh'))
    await flush(h.term)
    expect(lines(h.term)).toEqual(['fresh'])
    h.dispose()
  })

  it('换新的解码器：旧解码器里压着的半个字符被丢掉，不会和快照之后的字节拼起来', async () => {
    const h = mk()
    h.output(bytes(0xe3, 0x80), false) // 半个「。」
    h.snapshot(enc('S\r\n'))
    h.output(bytes(0x82), false) // 另半个落在快照之后
    await flush(h.term)
    expect(h.term.buffer.active.getLine(1)?.translateToString(true)).not.toContain('。')
    h.dispose()
  })

  it('快照末尾的半个字符留给下一帧接完', async () => {
    const h = mk()
    h.snapshot(new Uint8Array([...enc('A'), 0xe3, 0x80]))
    h.output(bytes(0x82), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('A。')
    h.dispose()
  })

  it('快照算回放：解析完之前 replaying() 为真', async () => {
    const h = mk()
    expect(h.replaying()).toBe(false)
    h.snapshot(enc('x'))
    expect(h.replaying()).toBe(true)
    await flush(h.term)
    expect(h.replaying()).toBe(false)
    h.output(enc('y'), true)
    expect(h.replaying()).toBe(true)
    await flush(h.term)
    expect(h.replaying()).toBe(false)
    h.output(enc('z'), false)
    expect(h.replaying(), 'live 输出不开门').toBe(false)
    h.dispose()
  })

  it('快照能把客户端带进备用屏', async () => {
    const h = mk()
    h.snapshot(enc('\x1b[?1049h\x1b[HFRAME 1'))
    await flush(h.term)
    expect(h.altScreen()).toBe(true)
    h.snapshot(enc('back'))
    await flush(h.term)
    expect(h.altScreen(), '下一份快照复位').toBe(false)
    h.dispose()
  })
})

describe('进程结束提示行（AC-4.5）', () => {
  it('文字照文档；退出码缺失时不写括号', () => {
    expect(exitLine(1)).toContain('[进程已结束（退出码 1）· 按 Enter 关闭]')
    expect(exitLine(0)).toContain('（退出码 0）')
    expect(exitLine(null)).toContain('[进程已结束 · 按 Enter 关闭]')
  })

  it('排在最后一段输出之后；光标不在行首时先换行', async () => {
    const h = mk()
    h.output(enc('LAST-LINE\r\n$ '), false)
    h.local('[END]')
    await flush(h.term)
    await flush(h.term)
    expect(lines(h.term)).toEqual(['LAST-LINE', '$ ', '[END]'])
    h.dispose()
  })

  it('光标在行首时不多空一行', async () => {
    const h = mk()
    h.output(enc('exit\r\n'), false)
    h.local('[END]')
    await flush(h.term)
    await flush(h.term)
    expect(lineText(h.term, 1)).toBe('[END]')
    h.dispose()
  })

  it('快照之前排下的提示行作废（快照会清屏，调用方在快照之后再写一次）', async () => {
    const h = mk()
    h.output(enc('a\r\n'), false)
    h.local('[END-1]')
    h.snapshot(enc('restored\r\n'))
    h.local('[END-2]')
    await flush(h.term)
    await flush(h.term)
    expect(lines(h.term)).toEqual(['restored', '[END-2]'])
    h.dispose()
  })
})

describe('UT-fit-1 行列 = 可用尺寸 ÷ 稳定的字符格尺寸（AC-3.11，ADR-0033）', () => {
  it('向下取整', () => {
    expect(proposeSize({ width: 800, height: 600 }, { width: 8, height: 17 })).toEqual({ cols: 100, rows: 35 })
  })

  it('900px 宽的实测数：字符宽 8.4287、可用 877px → 104 列，不管当前是几列', () => {
    // FitAddon 用的 css.cell.width 是「整行宽取整 ÷ 当前列数」：104 列时 877 / 104，103 列时 868 / 103 ——
    // 拿它们去除 877 分别得 103 和 104，每次 fit 都翻。字符本身的宽度（269.71875 / 32）与列数无关
    const cell = { width: 269.71875 / 32, height: 17 }
    expect(proposeSize({ width: 877, height: 676 }, cell)?.cols).toBe(104)
    expect(Math.floor(877 / (877 / 104)), '旧算法在 104 列时提议 103（877 ÷ (877/104) = 103.99999999999999）').toBe(103)
    expect(Math.floor(877 / (868 / 103)), '旧算法在 103 列时提议 104').toBe(104)
  })

  it('最少 2 列 1 行；格子尺寸量不到（还没渲染）时 null', () => {
    expect(proposeSize({ width: 3, height: 3 }, { width: 8, height: 17 })).toEqual({ cols: 2, rows: 1 })
    expect(proposeSize({ width: -20, height: 0 }, { width: 8, height: 17 })).toEqual({ cols: 2, rows: 1 })
    expect(proposeSize({ width: 800, height: 600 }, { width: 0, height: 17 })).toBeNull()
    expect(proposeSize({ width: 800, height: 600 }, { width: 8, height: NaN })).toBeNull()
  })
})

describe('xterm 配置', () => {
  it('scrollback 至少 5000 行（AC-5.1）', () => {
    const h = mk()
    expect(SCROLLBACK).toBeGreaterThanOrEqual(5000)
    expect(h.term.options.scrollback).toBe(SCROLLBACK)
    h.dispose()
  })

  it('UT-look-1 默认字号 14px、字体是系统等宽栈，带 CJK 等宽回退（AC-5.3）', () => {
    const h = mk()
    expect(FONT_DEFAULT).toBe(14)
    expect(h.term.options.fontSize).toBe(14)
    expect(createTerminal(undefined, 18).term.options.fontSize, '设置里改过字号：新实例用它').toBe(18)
    expect(h.term.options.fontFamily).toBe(FONT_FAMILY)
    expect(FONT_FAMILY).toMatch(/^ui-monospace, /)
    expect(FONT_FAMILY).toMatch(/"Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace$/)
    h.dispose()
  })

  it('鼠标跟踪状态现读', async () => {
    const h = mk()
    expect(h.mouseTracking()).toBe(false)
    h.output(enc('\x1b[?1000h'), false)
    await flush(h.term)
    expect(h.mouseTracking()).toBe(true)
    h.dispose()
  })

  it('主题从 CSS 变量读，没定义的项留给 xterm 默认', () => {
    const vars: Record<string, string> = { '--term-bg': ' #0d1117 ', '--term-fg': '#e6edf3', '--ansi-1': '#ff7b72' }
    const t = themeFromCss((n) => vars[n] ?? '')
    expect(t).toEqual({ background: '#0d1117', foreground: '#e6edf3', cursorAccent: '#0d1117', red: '#ff7b72' })
  })
})
