/**
 * 按键映射 —— docs/40-frontend/keymap.md。
 *
 * Raw 模式下绝大部分按键交给 xterm 的 onData（它已经正确实现了标准映射）。
 * 这里只负责两件事：
 *   1. 功能键条按下时要发的字节（那些键没有真实的 keydown 可以借用）
 *   2. 应用级快捷键的识别（拦下来不让它进 PTY）
 */

/** 控制字符。 */
export const ESC = '\x1b'

/**
 * 应用级快捷键必须用【终端程序收不到】的组合。
 *
 * Ctrl+<字母> 是终端控制码、Alt+<字母> 是 TUI 的 Meta 键、Ctrl+<数字> 被
 * 浏览器占用 —— 都不能用。Ctrl+Shift+* 不是合法的终端控制码，安全。
 */
export type AppAction =
  | 'palette'
  | 'search'
  | 'newSession'
  | 'closeSession'
  | 'prevSession'
  | 'nextSession'
  | 'toggleMode'
  | 'toggleSidebar'
  | 'settings'

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** 识别应用级快捷键。返回 null 表示这不是应用快捷键，应当放行给终端。 */
export function appAction(e: KeyEventLike): AppAction | null {
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.shiftKey && !e.altKey) {
    // Ctrl/Cmd+K 是命令面板的通用习惯，可拦截
    if (e.key === 'k' || e.key === 'K') return 'palette'
    if (e.key === 'f' || e.key === 'F') return 'search'
  }
  if (!(e.ctrlKey && e.shiftKey) || e.altKey) return null
  switch (e.key) {
    case 'Enter':
      return 'newSession'
    case 'W':
    case 'w':
      return 'closeSession'
    case 'ArrowUp':
      return 'prevSession'
    case 'ArrowDown':
      return 'nextSession'
    case 'M':
    case 'm':
      return 'toggleMode'
    case 'B':
    case 'b':
      return 'toggleSidebar'
    case '<':
    case ',':
      return 'settings'
    default:
      return null
  }
}

/**
 * 功能键条上的键 → 发给 PTY 的字节。
 *
 * 这些键在移动软键盘上不存在，所以没有真实的 keydown 事件可以借用，
 * 只能自己映射（AC-3.4 / AC-3.9）。
 */
export const KEY_BYTES: Readonly<Record<string, string>> = {
  Escape: ESC,
  Tab: '\t',
  Enter: '\r', // CR，不是 LF —— PTY 的行规程期望回车键的真实字节
  Backspace: '\x7f', // DEL，不是 0x08
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Delete: `${ESC}[3~`,
  Insert: `${ESC}[2~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
  ShiftTab: `${ESC}[Z`,
}

/**
 * 把一个字符与修饰键组合成要发送的字节。
 *
 * Ctrl+<字母> → 0x01..0x1a；Ctrl+[ \ ] 分别是 0x1b/0x1c/0x1d。
 * Alt+<字符> → ESC + 字符。
 */
export function chord(ch: string, mods: { ctrl?: boolean; alt?: boolean }): string {
  let out = ch
  if (mods.ctrl) {
    const c = ch.toLowerCase()
    if (c >= 'a' && c <= 'z') {
      out = String.fromCharCode(c.charCodeAt(0) - 96) // a → 0x01
    } else {
      switch (ch) {
        case '[':
          out = '\x1b'
          break
        case '\\':
          out = '\x1c'
          break
        case ']':
          out = '\x1d'
          break
        case '@':
        case ' ':
          out = '\x00'
          break
        case '?':
          out = '\x7f'
          break
        default:
          out = ch // 没有对应控制码，原样发
      }
    }
  }
  if (mods.alt) out = ESC + out
  return out
}

/** 功能键条上的按键集合（AC-3.9）。前 8 个在最窄屏幕下必须无需滚动即可见。 */
export const KEY_BAR: readonly { label: string; key: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Ctrl', key: 'Ctrl' },
  { label: 'Alt', key: 'Alt' },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '←', key: 'ArrowLeft' },
  { label: '→', key: 'ArrowRight' },
  { label: '|', key: '|' },
  { label: '~', key: '~' },
  { label: '/', key: '/' },
  { label: '-', key: '-' },
  { label: '_', key: '_' },
  { label: 'Home', key: 'Home' },
  { label: 'End', key: 'End' },
  { label: 'PgUp', key: 'PageUp' },
  { label: 'PgDn', key: 'PageDown' },
]
