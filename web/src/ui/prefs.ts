/**
 * This browser's two preferences: theme and terminal font size (AC-5.3, ADR-0037), both in
 * localStorage.
 *
 * Font size is stored once, not per form factor: the form factor comes from the screen's
 * short side and never changes on a device.
 */

export type Theme = 'system' | 'light' | 'dark'

export const THEME_KEY = 'webterm.theme'
export const FONT_SIZE_KEY = 'webterm.fontSize'
/** The extra keys are collapsed (ADR-0056): a UI state kept per device, not a setting. */
export const KEYS_COLLAPSED_KEY = 'webterm.keysCollapsed'
/** The file browser is maximized on wide screens (ADR-0060 §1). */
export const FILES_MAX_KEY = 'webterm.filesMax'

export const FONT_MIN = 10
export const FONT_MAX = 24
export const FONT_DEFAULT = 14

export function readTheme(): Theme {
  const v = safeGet(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/**
 * Applies the theme to `<html data-theme>`, removing it for System so
 * `prefers-color-scheme` takes over. CSS sets `color-scheme` from `data-theme`; not touched here.
 */
export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

export function writeTheme(t: Theme): void {
  safeSet(THEME_KEY, t)
}

/** Valid font sizes: integers 10–24. */
export function validFontSize(n: number): boolean {
  return Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX
}

export function readFontSize(): number {
  const n = Number(safeGet(FONT_SIZE_KEY)) // null / '' → 0, invalid
  return validFontSize(n) ? n : FONT_DEFAULT
}

export function writeFontSize(px: number): void {
  safeSet(FONT_SIZE_KEY, String(px))
}

export function readKeysCollapsed(): boolean {
  return safeGet(KEYS_COLLAPSED_KEY) === '1'
}

export function writeKeysCollapsed(collapsed: boolean): void {
  safeSet(KEYS_COLLAPSED_KEY, collapsed ? '1' : '0')
}

export function readFilesMax(): boolean {
  return safeGet(FILES_MAX_KEY) === '1'
}

export function writeFilesMax(max: boolean): void {
  safeSet(FILES_MAX_KEY, max ? '1' : '0')
}

// localStorage throws in private windows or with site data disabled, so wrap every access.
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
    /* Not remembering is fine; crashing is not */
  }
}
