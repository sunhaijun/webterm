/**
 * 按键映射 —— docs/40-frontend/keymap.md。
 *
 * 终端直输时绝大部分按键交给 xterm 的 onData（它已经正确实现了标准映射）。
 * 这里只负责三件事：
 *   1. 附加键（两行 14 键，ADR-0025 §2）要发的字节 —— 与实体键盘同一编码，含 DECCKM；
 *   2. CTRL / ALT 粘滞修饰：附加键与软键盘的下一个字符都吃它；
 *   3. 应用级快捷键的识别（拦下来不让它进 PTY）。
 */

/** 控制字符。 */
export const ESC = '\x1b'

// ---------- 应用级快捷键 ----------

/**
 * 应用级快捷键只用 `Ctrl+Shift+*`：Ctrl+<字母> 是终端控制码、Alt+<字母> 是 TUI 的
 * Meta 键、Ctrl+Alt 在 Windows / 欧洲键盘上是 AltGr、Ctrl+<数字> 被浏览器占用。
 * `Ctrl/Cmd+F`、`Ctrl/Cmd+K` 都不拦，交还给浏览器或终端。
 */
export type AppAction =
  | 'newSession'
  | 'closeSession'
  | 'prevSession'
  | 'nextSession'
  | 'toggleSessions'

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** 识别应用级快捷键。返回 null 表示这不是应用快捷键，应当放行给终端。 */
export function appAction(e: KeyEventLike): AppAction | null {
  if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return null
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
    case 'B':
    case 'b':
      return 'toggleSessions'
    default:
      return null
  }
}

// ---------- 键到字节 ----------

/** 实体键盘上这些键的字节（keymap.md 的表）。方向键 / Home / End 见 `cursorKey`。 */
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

/** 跟随 DECCKM 的键与它的终结字符。 */
const CURSOR_FINAL: Readonly<Record<string, string>> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
}

/**
 * 方向键与 Home / End：应用光标键模式（DECCKM）下发 `ESC O x`，否则 `ESC [ x`。
 * DECCKM 的状态由调用方**每次按键时现读**（`term.modes.applicationCursorKeysMode`），
 * 不缓存：程序退出时会复位它。
 */
export function cursorKey(key: string, decckm: boolean): string | undefined {
  const fin = CURSOR_FINAL[key]
  return fin === undefined ? undefined : `${ESC}${decckm ? 'O' : '['}${fin}`
}

export interface Mods {
  ctrl: boolean
  alt: boolean
}

export const NO_MODS: Mods = { ctrl: false, alt: false }

/**
 * 一个字符加上修饰（keymap.md §附加键的粘滞修饰）。
 *
 * CTRL：字母（大小写不分）→ 0x01–0x1a；`[ \ ] ^ _` → 0x1b–0x1f；`@` / 空格 → 0x00；
 * `?` → 0x7f；其它原样。ALT：前缀 ESC。两个都有时先做 CTRL 再加 ESC。
 */
export function chord(ch: string, mods: Partial<Mods>): string {
  let out = ch
  if (mods.ctrl) {
    const c = ch.toLowerCase()
    if (c.length === 1 && c >= 'a' && c <= 'z') {
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
        case '^':
          out = '\x1e'
          break
        case '_':
          out = '\x1f'
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

/** xterm 的修饰参数：1 + Shift(1) + Alt(2) + Ctrl(4)。 */
function modParam(mods: Mods): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

// ---------- 附加键（ADR-0025 §2，input.md §附加键） ----------

export type ExtraKeyId =
  | 'Escape'
  | 'Slash'
  | 'Minus'
  | 'Home'
  | 'ArrowUp'
  | 'End'
  | 'PageUp'
  | 'Tab'
  | 'Ctrl'
  | 'Alt'
  | 'ArrowLeft'
  | 'ArrowDown'
  | 'ArrowRight'
  | 'PageDown'

export interface ExtraKey {
  id: ExtraKeyId
  label: string
}

/**
 * Termux 的默认键位，两行、静态：不随前台程序、提示符状态变。
 * testid 是 `key-<id>`。
 */
export const EXTRA_KEYS: readonly (readonly ExtraKey[])[] = [
  [
    { id: 'Escape', label: 'ESC' },
    { id: 'Slash', label: '/' },
    { id: 'Minus', label: '-' },
    { id: 'Home', label: 'HOME' },
    { id: 'ArrowUp', label: '↑' },
    { id: 'End', label: 'END' },
    { id: 'PageUp', label: 'PGUP' },
  ],
  [
    { id: 'Tab', label: 'TAB' },
    { id: 'Ctrl', label: 'CTRL' },
    { id: 'Alt', label: 'ALT' },
    { id: 'ArrowLeft', label: '←' },
    { id: 'ArrowDown', label: '↓' },
    { id: 'ArrowRight', label: '→' },
    { id: 'PageDown', label: 'PGDN' },
  ],
]

/** 修饰键（粘滞）本身不发字节。 */
export function isModifierKey(id: ExtraKeyId): id is 'Ctrl' | 'Alt' {
  return id === 'Ctrl' || id === 'Alt'
}

const PAGE_NUM: Partial<Record<ExtraKeyId, number>> = { PageUp: 5, PageDown: 6 }
const CHAR_OF: Partial<Record<ExtraKeyId, string>> = { Slash: '/', Minus: '-', Escape: ESC, Tab: '\t' }

/**
 * 附加键 → 字节，与实体键盘同一编码（keymap.md）。
 *
 * - 方向键 / HOME / END：无修饰时跟随 DECCKM；有修饰时用 xterm 的修饰编码 `ESC [ 1 ; m X`
 *   （修饰形式不受 DECCKM 影响，xterm 也是这么做的）；
 * - PGUP / PGDN：`ESC [ 5 ~` / `ESC [ 6 ~`，有修饰时 `ESC [ 5 ; m ~`；
 * - ESC / TAB：CTRL 下原样，ALT 下前缀 ESC；
 * - `/` `-`：按 `chord` 组合（CTRL 下原样，ALT 下前缀 ESC）。
 */
export function extraKeyBytes(id: ExtraKeyId, mods: Mods, decckm: boolean): string {
  if (isModifierKey(id)) return ''
  const any = mods.ctrl || mods.alt
  const fin = CURSOR_FINAL[id]
  if (fin !== undefined) {
    return any ? `${ESC}[1;${modParam(mods)}${fin}` : cursorKey(id, decckm)!
  }
  const page = PAGE_NUM[id]
  if (page !== undefined) {
    return any ? `${ESC}[${page};${modParam(mods)}~` : `${ESC}[${page}~`
  }
  const ch = CHAR_OF[id]!
  return chord(ch, mods)
}

// ---------- CTRL / ALT 粘滞（input.md §行为） ----------

export type StickyState = 'off' | 'armed' | 'locked'
export type StickyMod = 'ctrl' | 'alt'

/**
 * 粘滞修饰的状态机。
 *
 * 点一下 → armed，只对**下一个键**生效；长按 → locked，连续生效；再点一下 → off。
 * 下一个键可以来自附加键（`take()`），也可以来自软键盘（`apply()`，挂在终端的
 * onData 出口上）。
 */
export class Sticky {
  private readonly s: Record<StickyMod, StickyState> = { ctrl: 'off', alt: 'off' }
  private readonly listeners = new Set<() => void>()

  state(m: StickyMod): StickyState {
    return this.s[m]
  }

  mods(): Mods {
    return { ctrl: this.s.ctrl !== 'off', alt: this.s.alt !== 'off' }
  }

  /** 点一下：off → armed；armed / locked → off。 */
  tap(m: StickyMod): void {
    this.set(m, this.s[m] === 'off' ? 'armed' : 'off')
  }

  /** 长按：锁定。 */
  hold(m: StickyMod): void {
    this.set(m, 'locked')
  }

  /** 附加键用：取出当前修饰并消耗 armed（locked 保持）。 */
  take(): Mods {
    const mods = this.mods()
    this.consume()
    return mods
  }

  /**
   * onData 出口用：单个字符按修饰组合后返回，并消耗 armed；
   * 没有修饰、或不是单个字符（粘贴、组字提交的一段、终端应答）时原样返回、不消耗。
   */
  apply(data: string): string {
    const mods = this.mods()
    if (!mods.ctrl && !mods.alt) return data
    if ([...data].length !== 1) return data
    this.consume()
    return chord(data, mods)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private consume(): void {
    let changed = false
    for (const m of ['ctrl', 'alt'] as const) {
      if (this.s[m] === 'armed') {
        this.s[m] = 'off'
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private set(m: StickyMod, v: StickyState): void {
    if (this.s[m] === v) return
    this.s[m] = v
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}
