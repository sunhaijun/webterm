/**
 * Composer 的历史导航 —— docs/40-frontend/input-modes.md §历史导航。
 *
 * 历史来源是 agent 的 commands 表（不是浏览器 localStorage），所以跨设备一致。
 */

export interface HistoryNav {
  /** 当前应当显示的内容，null 表示保持原样。 */
  text: string | null
}

export class HistoryCursor {
  private items: string[] = []
  /** -1 表示不在历史里（正在编辑自己的输入）。 */
  private index = -1
  /** 进入历史前暂存的输入，走到底再按 ↓ 能回到它。 */
  private draft = ''
  private prefix = ''

  /** 是否正在浏览历史。 */
  get browsing(): boolean {
    return this.index >= 0
  }

  /** 当前用的前缀（有输入内容时按 ↑ 只翻以它开头的）。 */
  get activePrefix(): string {
    return this.prefix
  }

  /** 载入一批候选（按最近执行时间倒序，已去重）。 */
  load(prefix: string, items: string[], draft: string): void {
    this.prefix = prefix
    this.items = items
    this.draft = draft
    this.index = -1
  }

  /** ↑：往更旧的方向走。 */
  older(): HistoryNav {
    if (this.items.length === 0) return { text: null }
    if (this.index + 1 >= this.items.length) return { text: null } // 到底了，停住
    this.index++
    return { text: this.items[this.index] ?? null }
  }

  /** ↓：往更新的方向走；走出历史就回到暂存的草稿。 */
  newer(): HistoryNav {
    if (this.index < 0) return { text: null }
    this.index--
    if (this.index < 0) return { text: this.draft }
    return { text: this.items[this.index] ?? null }
  }

  reset(): void {
    this.items = []
    this.index = -1
    this.draft = ''
    this.prefix = ''
  }
}

/** 拉取历史候选。空前缀时翻全部。 */
export async function fetchHistory(prefix: string, limit = 50): Promise<string[]> {
  const url = new URL('/api/commands', location.origin)
  if (prefix) url.searchParams.set('prefix', prefix)
  url.searchParams.set('limit', String(limit))
  const r = await fetch(url, { credentials: 'same-origin' })
  if (!r.ok) return []
  const body = (await r.json()) as { items?: { text: string }[] }
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of body.items ?? []) {
    // 空前缀走的是普通列表，那条路径不去重，这里补上
    if (seen.has(it.text)) continue
    seen.add(it.text)
    out.push(it.text)
  }
  return out
}

/**
 * 光标在首行行首时按 ↑ 才翻历史，否则正常移动光标。
 *
 * 这条很重要：多行输入里按 ↑ 的意图通常是"上移一行"，不是"翻历史"。
 */
export function atFirstLineStart(_value: string, selStart: number, selEnd: number): boolean {
  if (selStart !== selEnd) return false
  return selStart === 0
}

/** 光标在末行行尾时按 ↓ 才翻历史。 */
export function atLastLineEnd(value: string, selStart: number, selEnd: number): boolean {
  if (selStart !== selEnd) return false
  return selStart === value.length
}
