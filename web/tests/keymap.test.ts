/** UT-keymap-1 / UT-keys-1：键到字节、附加键、粘滞修饰、应用快捷键，对照 docs/40-frontend/keymap.md。 */
import { describe, expect, it } from 'vitest'

import {
  EXTRA_KEYS,
  KEY_BYTES,
  NO_MODS,
  Sticky,
  appAction,
  chord,
  cursorKey,
  extraKeyBytes,
  isModifierKey,
  type ExtraKeyId,
} from '../src/keys/keymap'

const ESC = '\x1b'

describe('UT-keymap-1 控制键映射', () => {
  it('Ctrl+<字母> → 0x01..0x1a', () => {
    expect(chord('a', { ctrl: true })).toBe('\x01')
    expect(chord('c', { ctrl: true })).toBe('\x03') // 打断
    expect(chord('d', { ctrl: true })).toBe('\x04') // EOF
    expect(chord('z', { ctrl: true })).toBe('\x1a')
    expect(chord('C', { ctrl: true }), '大写也要认').toBe('\x03')
  })

  it('Ctrl+[ \\ ] ^ _ 的控制码', () => {
    expect(chord('[', { ctrl: true })).toBe('\x1b')
    expect(chord('\\', { ctrl: true })).toBe('\x1c')
    expect(chord(']', { ctrl: true })).toBe('\x1d')
    expect(chord('^', { ctrl: true })).toBe('\x1e')
    expect(chord('_', { ctrl: true })).toBe('\x1f')
  })

  it('Ctrl+@ / 空格 → 0x00，Ctrl+? → 0x7f，其它可打印字符原样', () => {
    expect(chord('@', { ctrl: true })).toBe('\x00')
    expect(chord(' ', { ctrl: true })).toBe('\x00')
    expect(chord('?', { ctrl: true })).toBe('\x7f')
    expect(chord('/', { ctrl: true })).toBe('/')
    expect(chord('-', { ctrl: true })).toBe('-')
    expect(chord('1', { ctrl: true })).toBe('1')
    expect(chord('中', { ctrl: true })).toBe('中')
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

  it('Ctrl/Cmd+K 归还终端（readline 的「删到行尾」，ADR-0022）', () => {
    // 命令面板删掉之后这个键不再被应用层拦截 —— 拦它等于拦了一个终端真正在用的键
    expect(appAction(key('k', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('K', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('k', { metaKey: true }))).toBeNull()
  })

  it('Ctrl/Cmd+F 不再拦截（会话内搜索已删除，ADR-0025 §7），交还给浏览器或终端', () => {
    expect(appAction(key('f', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('F', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('f', { metaKey: true }))).toBeNull()
  })

  it('Ctrl+Shift+* 是应用快捷键', () => {
    expect(appAction(key('Enter', { ctrlKey: true, shiftKey: true }))).toBe('newSession')
    // Ctrl+M 就是终端的 Enter（CR）—— 绝不能拿 Ctrl+Shift+M 当应用快捷键，会撞回车
    expect(appAction(key('M', { ctrlKey: true, shiftKey: true })), 'Ctrl+M 是终端 Enter').toBeNull()
    expect(appAction(key('ArrowUp', { ctrlKey: true, shiftKey: true }))).toBe('prevSession')
    expect(appAction(key('ArrowDown', { ctrlKey: true, shiftKey: true }))).toBe('nextSession')
    expect(appAction(key('W', { ctrlKey: true, shiftKey: true }))).toBe('closeSession')
    expect(appAction(key('B', { ctrlKey: true, shiftKey: true }))).toBe('toggleSessions')
  })

  it('UT-look-1 Ctrl+Shift+, 不再是快捷键（没有设置，ADR-0030），交给终端', () => {
    expect(appAction(key('<', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(appAction(key(',', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('Ctrl+Alt+* 不当快捷键（Windows / 欧洲键盘上是 AltGr）', () => {
    expect(appAction(key('Enter', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
    expect(appAction(key('b', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('【绝不能】拦截终端要用的组合', () => {
    // Ctrl+C / Ctrl+D / Ctrl+R 必须原样进 PTY，否则 vim、less、Ctrl+C 全废
    // Ctrl+K 是 readline 的"删到行尾"，同样不能拦（ADR-0022）
    for (const k of ['c', 'd', 'r', 'a', 'e', 'u', 'z', 'k']) {
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

describe('UT-keymap-1 DECCKM：方向键与 HOME / END 跟随应用光标键模式', () => {
  it('关着时 CSI，开着时 SS3', () => {
    expect(cursorKey('ArrowUp', false)).toBe(`${ESC}[A`)
    expect(cursorKey('ArrowUp', true)).toBe(`${ESC}OA`)
    expect(cursorKey('ArrowLeft', true)).toBe(`${ESC}OD`)
    expect(cursorKey('Home', false)).toBe(`${ESC}[H`)
    expect(cursorKey('Home', true)).toBe(`${ESC}OH`)
    expect(cursorKey('End', true)).toBe(`${ESC}OF`)
    expect(cursorKey('PageUp', true), 'PGUP 不跟随 DECCKM').toBeUndefined()
  })
})

describe('UT-keys-1 附加键（AC-3.18）', () => {
  it('两行共 14 个键，依次是 Termux 的默认键位', () => {
    expect(EXTRA_KEYS.map((row) => row.map((k) => k.label))).toEqual([
      ['ESC', '/', '-', 'HOME', '↑', 'END', 'PGUP'],
      ['TAB', 'CTRL', 'ALT', '←', '↓', '→', 'PGDN'],
    ])
    expect(EXTRA_KEYS.flat().map((k) => `key-${k.id}`)).toEqual([
      'key-Escape', 'key-Slash', 'key-Minus', 'key-Home', 'key-ArrowUp', 'key-End', 'key-PageUp',
      'key-Tab', 'key-Ctrl', 'key-Alt', 'key-ArrowLeft', 'key-ArrowDown', 'key-ArrowRight', 'key-PageDown',
    ])
  })

  it('无修饰时与实体键盘同一编码', () => {
    const b = (id: ExtraKeyId, decckm = false) => extraKeyBytes(id, NO_MODS, decckm)
    expect(b('Escape')).toBe('\x1b')
    expect(b('Slash')).toBe('/')
    expect(b('Minus')).toBe('-')
    expect(b('Tab')).toBe('\t')
    expect(b('ArrowUp')).toBe('\x1b[A')
    expect(b('ArrowDown')).toBe('\x1b[B')
    expect(b('ArrowRight')).toBe('\x1b[C')
    expect(b('ArrowLeft')).toBe('\x1b[D')
    expect(b('Home')).toBe('\x1b[H')
    expect(b('End')).toBe('\x1b[F')
    expect(b('PageUp')).toBe('\x1b[5~')
    expect(b('PageDown')).toBe('\x1b[6~')
    for (const id of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const) {
      expect(b(id), `${id} 与 KEY_BYTES 一致`).toBe(KEY_BYTES[id])
    }
  })

  it('DECCKM 开着时方向键 / HOME / END 发 SS3（E2E-10 ④：↑ → 1b4f41，HOME → 1b4f48）', () => {
    expect(extraKeyBytes('ArrowUp', NO_MODS, true)).toBe('\x1bOA')
    expect(extraKeyBytes('Home', NO_MODS, true)).toBe('\x1bOH')
    expect(extraKeyBytes('End', NO_MODS, true)).toBe('\x1bOF')
    expect(extraKeyBytes('PageUp', NO_MODS, true), 'PGUP 不受影响').toBe('\x1b[5~')
  })

  it('CTRL / ALT 下的方向键用 xterm 的修饰编码（E2E-10 ⑥：CTRL+← → 1b5b313b3544）', () => {
    expect(extraKeyBytes('ArrowLeft', { ctrl: true, alt: false }, false)).toBe('\x1b[1;5D')
    expect(extraKeyBytes('ArrowUp', { ctrl: false, alt: true }, false)).toBe('\x1b[1;3A')
    expect(extraKeyBytes('ArrowUp', { ctrl: true, alt: true }, false)).toBe('\x1b[1;7A')
    expect(extraKeyBytes('ArrowUp', { ctrl: true, alt: false }, true), '修饰形式不随 DECCKM').toBe('\x1b[1;5A')
    expect(extraKeyBytes('Home', { ctrl: true, alt: false }, false)).toBe('\x1b[1;5H')
    expect(extraKeyBytes('PageUp', { ctrl: true, alt: false }, false)).toBe('\x1b[5;5~')
    expect(extraKeyBytes('PageDown', { ctrl: false, alt: true }, false)).toBe('\x1b[6;3~')
  })

  it('ESC / TAB：CTRL 下原样，ALT 下前缀 ESC；/ - 按 chord', () => {
    expect(extraKeyBytes('Escape', { ctrl: true, alt: false }, false)).toBe('\x1b')
    expect(extraKeyBytes('Escape', { ctrl: false, alt: true }, false)).toBe('\x1b\x1b')
    expect(extraKeyBytes('Tab', { ctrl: true, alt: false }, false)).toBe('\t')
    expect(extraKeyBytes('Tab', { ctrl: false, alt: true }, false)).toBe('\x1b\t')
    expect(extraKeyBytes('Slash', { ctrl: true, alt: false }, false)).toBe('/')
    expect(extraKeyBytes('Minus', { ctrl: false, alt: true }, false)).toBe('\x1b-')
  })

  it('CTRL / ALT 本身不发字节', () => {
    expect(isModifierKey('Ctrl')).toBe(true)
    expect(isModifierKey('Alt')).toBe(true)
    expect(isModifierKey('Tab')).toBe(false)
    expect(extraKeyBytes('Ctrl', NO_MODS, false)).toBe('')
  })
})

describe('UT-keys-1 CTRL / ALT 粘滞', () => {
  it('点一下 armed，只对下一个键生效，然后自动回到 off', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.state('ctrl')).toBe('armed')
    expect(s.take()).toEqual({ ctrl: true, alt: false })
    expect(s.state('ctrl')).toBe('off')
    expect(s.take()).toEqual({ ctrl: false, alt: false })
  })

  it('armed 时再点一下就解除', () => {
    const s = new Sticky()
    s.tap('alt')
    s.tap('alt')
    expect(s.state('alt')).toBe('off')
  })

  it('长按锁定：连续多次组合（Ctrl+C 接 Ctrl+D），再点一下解锁', () => {
    const s = new Sticky()
    s.hold('ctrl')
    expect(s.state('ctrl')).toBe('locked')
    expect(s.apply('c')).toBe('\x03')
    expect(s.apply('d')).toBe('\x04')
    expect(s.state('ctrl')).toBe('locked')
    s.tap('ctrl')
    expect(s.state('ctrl')).toBe('off')
    expect(s.apply('c')).toBe('c')
  })

  it('软键盘打出来的下一个字符也吃修饰（onData 出口）', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.apply('c'), 'E2E-10 ⑥：CTRL armed + 软键盘 c → 03').toBe('\x03')
    expect(s.state('ctrl')).toBe('off')
    s.tap('alt')
    expect(s.apply('b')).toBe('\x1bb')
    expect(s.state('alt')).toBe('off')
  })

  it('CTRL 与 ALT 同时：先 CTRL 变换再加 ESC', () => {
    const s = new Sticky()
    s.tap('ctrl')
    s.tap('alt')
    expect(s.apply('c')).toBe('\x1b\x03')
    expect(s.mods()).toEqual({ ctrl: false, alt: false })
  })

  it('不是单个字符（粘贴、组字提交的一段、终端应答）原样放过，也不消耗', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.apply('你好')).toBe('你好')
    expect(s.apply('\x1b[12;1R')).toBe('\x1b[12;1R')
    expect(s.state('ctrl')).toBe('armed')
    expect(s.apply('中'), '单个汉字也算一个字符：原样但消耗').toBe('中')
    expect(s.state('ctrl')).toBe('off')
  })

  it('没有修饰时什么都不做', () => {
    const s = new Sticky()
    expect(s.apply('a')).toBe('a')
  })

  it('状态变化通知订阅者（界面靠它刷新 data-sticky）', () => {
    const s = new Sticky()
    let n = 0
    const off = s.subscribe(() => n++)
    s.tap('ctrl') // off → armed
    s.apply('x') // armed → off
    s.apply('y') // 没变化，不通知
    s.hold('alt')
    off()
    s.tap('alt')
    expect(n).toBe(3)
  })
})
