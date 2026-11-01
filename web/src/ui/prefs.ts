/**
 * 这台浏览器的两项偏好：主题与终端字号（AC-5.3，ADR-0037）。都在 localStorage。
 *
 * 字号只存一份、不按形态分：形态由屏幕短边决定，在一台设备上不变。
 */

export type Theme = 'system' | 'light' | 'dark'

export const THEME_KEY = 'webterm.theme'
export const FONT_SIZE_KEY = 'webterm.fontSize'

export const FONT_MIN = 10
export const FONT_MAX = 24
export const FONT_DEFAULT = 14

export function readTheme(): Theme {
  const v = safeGet(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/**
 * 打到 `<html data-theme>` 上。跟随系统时去掉，靠 `prefers-color-scheme`。
 * `color-scheme` 由 CSS 按 `data-theme` 设，这里不碰。
 */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

export function writeTheme(t: Theme): void {
  safeSet(THEME_KEY, t)
}

/** 合法字号：10–24 的整数。 */
export function validFontSize(n: number): boolean {
  return Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX
}

export function readFontSize(): number {
  const n = Number(safeGet(FONT_SIZE_KEY)) // null / '' → 0，不合法
  return validFontSize(n) ? n : FONT_DEFAULT
}

export function writeFontSize(px: number): void {
  safeSet(FONT_SIZE_KEY, String(px))
}

// localStorage 在隐私窗口 / 禁用站点数据时会直接抛异常，全部包起来。
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 记不住就算了，不能因此崩掉 */
  }
}
