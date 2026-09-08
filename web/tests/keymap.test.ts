/** UT-keymap-1：控制键映射表，对照 docs/40-frontend/keymap.md。 */
import { describe, expect, it } from 'vitest'

import { CTRL_KEYS, KEY_BAR, KEY_BYTES, appAction, chord } from '../src/input/keymap'

const ESC = '\x1b'

describe('UT-keymap-1 控制键映射', () => {
  it('Ctrl+<字母> → 0x01..0x1a', () => {
    expect(chord('a', { ctrl: true })).toBe('\x01')
    expect(chord('c', { ctrl: true })).toBe('\x03') // 打断
    expect(chord('d', { ctrl: true })).toBe('\x04') // EOF
    expect(chord('z', { ctrl: true })).toBe('\x1a')
    expect(chord('C', { ctrl: true }), '大写也要认').toBe('\x03')
  })

  it('Ctrl+[ / \\ / ] 的控制码', () => {
    expect(chord('[', { ctrl: true })).toBe('\x1b')
    expect(chord('\\', { ctrl: true })).toBe('\x1c')
    expect(chord(']', { ctrl: true })).toBe('\x1d')
  })

  it('Alt+<字符> → ESC + 字符', () => {
    expect(chord('b', { alt: true })).toBe(`${ESC}b`)
    expect(chord('f', { alt: true })).toBe(`${ESC}f`)
  })

  it('Ctrl+Alt 组合叠加', () => {
    expect(chord('c', { ctrl: true, alt: true })).toBe(`${ESC}\x03`)
  })

  it('特殊键的字节严格对照文档', () => {
    expect(KEY_BYTES.Backspace, 'Backspace 是 DEL(0x7f) 不是 0x08').toBe('\x7f')
    expect(KEY_BYTES.Enter, 'Enter 是 CR 不是 LF').toBe('\r')
    expect(KEY_BYTES.Escape).toBe(ESC)
    expect(KEY_BYTES.Tab).toBe('\t')
    expect(KEY_BYTES.ArrowUp).toBe(`${ESC}[A`)
    expect(KEY_BYTES.ArrowDown).toBe(`${ESC}[B`)
    expect(KEY_BYTES.ArrowRight).toBe(`${ESC}[C`)
    expect(KEY_BYTES.ArrowLeft).toBe(`${ESC}[D`)
    expect(KEY_BYTES.Home).toBe(`${ESC}[H`)
    expect(KEY_BYTES.End).toBe(`${ESC}[F`)
    expect(KEY_BYTES.PageUp).toBe(`${ESC}[5~`)
    expect(KEY_BYTES.PageDown).toBe(`${ESC}[6~`)
    expect(KEY_BYTES.Delete).toBe(`${ESC}[3~`)
    expect(KEY_BYTES.Insert).toBe(`${ESC}[2~`)
    expect(KEY_BYTES.ShiftTab).toBe(`${ESC}[Z`)
  })

  it('F1–F4 用 SS3，F5–F12 用 CSI', () => {
    expect(KEY_BYTES.F1).toBe(`${ESC}OP`)
    expect(KEY_BYTES.F4).toBe(`${ESC}OS`)
    expect(KEY_BYTES.F5).toBe(`${ESC}[15~`)
    expect(KEY_BYTES.F12).toBe(`${ESC}[24~`)
    // F 键的编号有跳号（没有 16/22），照抄文档
    expect(KEY_BYTES.F6).toBe(`${ESC}[17~`)
    expect(KEY_BYTES.F11).toBe(`${ESC}[23~`)
  })
})

describe('应用级快捷键', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  })

  it('Ctrl/Cmd+K 是命令面板总入口', () => {
    expect(appAction(key('k', { ctrlKey: true }))).toBe('palette')
    expect(appAction(key('k', { metaKey: true }))).toBe('palette')
  })

  it('Ctrl+Shift+* 是应用快捷键', () => {
    expect(appAction(key('Enter', { ctrlKey: true, shiftKey: true }))).toBe('newSession')
    expect(appAction(key('M', { ctrlKey: true, shiftKey: true }))).toBe('toggleMode')
    expect(appAction(key('ArrowUp', { ctrlKey: true, shiftKey: true }))).toBe('prevSession')
  })

  it('【绝不能】拦截终端要用的组合', () => {
    // Ctrl+C / Ctrl+D / Ctrl+R 必须原样进 PTY，否则 vim、less、Ctrl+C 全废
    for (const k of ['c', 'd', 'r', 'a', 'e', 'u', 'z']) {
      expect(appAction(key(k, { ctrlKey: true })), `Ctrl+${k} 被应用层吃掉了`).toBeNull()
    }
    // Alt+<字母> 是 TUI 的 Meta 键
    for (const k of ['b', 'f', 'd']) {
      expect(appAction(key(k, { altKey: true })), `Alt+${k} 被吃掉了`).toBeNull()
    }
    // 裸按键当然不拦
    expect(appAction(key('a'))).toBeNull()
    expect(appAction(key('Enter'))).toBeNull()
  })
})

describe('功能键条', () => {
  it('前 8 个键在最窄屏幕下必须无需滚动即可见', () => {
    const first8 = KEY_BAR.slice(0, 8).map((k) => k.label)
    // Alt 让位给 ^C。手机上 Alt 远比 ^C 罕见，而要 ^C 的时候通常
    // 已经卡住了（比如误进 top），不能还要求先横向滚一下。
    expect(first8).toEqual(['Esc', '^C', 'Tab', 'Ctrl', '↑', '↓', '←', '→'])
  })

  it('包含文档要求的全部按键（AC-3.9）', () => {
    const labels = KEY_BAR.map((k) => k.label)
    const want_ = ['Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→', '|', '~', '/', '-', '^C', '^D', '^Z', '^L']
    for (const want of want_) {
      expect(labels, `功能键条缺 ${want}`).toContain(want)
    }
  })
})

/**
 * 一按直发的控制码。
 *
 * 【粘滞 Ctrl 不够用】：它要求"点 Ctrl 再从软键盘打 c"，而 Raw 模式下
 * 看 top 时软键盘根本没弹出来 —— 真卡住过，进了 top 退不出来。
 */
describe('CTRL_KEYS 直发控制码', () => {
  it('^C 是 0x03', () => {
    expect(CTRL_KEYS.CtrlC).toBe('\x03')
  })
  it('^D / ^Z / ^L 分别是 0x04 / 0x1a / 0x0c', () => {
    expect(CTRL_KEYS.CtrlD).toBe('\x04')
    expect(CTRL_KEYS.CtrlZ).toBe('\x1a')
    expect(CTRL_KEYS.CtrlL).toBe('\x0c')
  })
  it('和粘滞 Ctrl 走 chord 得到的结果一致', () => {
    expect(CTRL_KEYS.CtrlC).toBe(chord('c', { ctrl: true }))
    expect(CTRL_KEYS.CtrlD).toBe(chord('d', { ctrl: true }))
  })
})

describe('功能键条的排布', () => {
  it('^C 必须在免滚动的前 8 个里 —— 它是唯一的通用脱困键', () => {
    const first8 = KEY_BAR.slice(0, 8).map((k) => k.key)
    expect(first8).toContain('CtrlC')
  })
  it('每个 CTRL_KEYS 都要有对应的按键', () => {
    const keys = KEY_BAR.map((k) => k.key)
    for (const k of Object.keys(CTRL_KEYS)) expect(keys).toContain(k)
  })
  it('按键不重复', () => {
    const keys = KEY_BAR.map((k) => k.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
