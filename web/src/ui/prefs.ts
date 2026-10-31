/**
 * 这台浏览器的偏好：主题、字号（按形态各存一份，AC-5.3）。全部在 localStorage。
 *
 * 字体 family 在 `fonts.ts`（全局一份、不按形态分，ADR-0023）。
 */

export type Theme = 'system' | 'light' | 'dark'
/** 与 `app/form.ts` 的 Form 同形；这里不依赖装配层。 */
export type FormKey = 'compact' | 'wide'

const THEME_KEY = 'webterm.theme'
const FONT_SIZE_KEY = 'webterm.fontSize'

export const FONT_MIN = 8
export const FONT_MAX = 32
export const FONT_DEFAULT = 14

export function readTheme(): Theme {
  const v = safeGet(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/** 打到 `<html data-theme>` 上并记住。跟随系统时不打标记，靠 prefers-color-scheme。 */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
  safeSet(THEME_KEY, t)
}

export function fontSizeKey(form: FormKey): string {
  return `${FONT_SIZE_KEY}.${form}`
}

/** 合法字号：8–32 的整数。 */
export function validFontSize(n: number): boolean {
  return Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX
}

export function readFontSize(form: FormKey): number {
  const raw = safeGet(fontSizeKey(form))
  const n = raw ? Number(raw) : NaN
  return validFontSize(n) ? n : FONT_DEFAULT
}

export function writeFontSize(form: FormKey, px: number): void {
  safeSet(fontSizeKey(form), String(px))
}

// localStorage 在隐私窗口 / 禁用站点数据时会直接抛异常，全部包起来。
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
