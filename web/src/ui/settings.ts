/** 主题与字号 —— 存 localStorage，按断点分别记（AC-5.3）。 */
import { breakpoint, type Breakpoint } from './viewport'

export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'webterm.theme'
const FONT_KEY = 'webterm.font'

/** 各断点的默认字号。手机竖屏刻意偏大：可读 > 兼容宽输出。 */
const DEFAULT_FONT: Record<Breakpoint, number> = {
  phone: 14,
  tablet: 14,
  desktop: 14,
}

export function readTheme(): Theme {
  const v = safeGet(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
  safeSet(THEME_KEY, t)
}

export function readFontSize(width = window.innerWidth): number {
  const bp = breakpoint(width)
  const raw = safeGet(`${FONT_KEY}.${bp}`)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 8 && n <= 32 ? n : DEFAULT_FONT[bp]
}

export function writeFontSize(px: number, width = window.innerWidth): void {
  safeSet(`${FONT_KEY}.${breakpoint(width)}`, String(px))
}

// localStorage 在隐私窗口 / 禁用站点数据时会直接抛异常，全部包起来。
// 侧栏几何（sidebar.ts）也用这两个，别再抄一份。
export function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

export function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 记不住就算了，不能因此崩掉 */
  }
}
