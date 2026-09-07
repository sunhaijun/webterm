/** 命令历史与快捷命令的 API 客户端 —— docs/30-protocol/http-api.md。 */

export interface CommandRecord {
  id: number
  text: string
  session_name: string
  cwd: string
  exit_code: number | null
  started_at: number
  duration_ms: number | null
  pinned: boolean
  label: string | null
  pin_order: number | null
}

export interface ListQuery {
  q?: string
  cwd?: string
  failed?: boolean
  pinned?: boolean
  limit?: number
  before?: number
}

export interface ListResult {
  items: CommandRecord[]
  next_before: number | null
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { credentials: 'same-origin', ...init })
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${input} → ${r.status}`)
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

/**
 * 拿到的 items 一律保证是数组。
 *
 * 服务端已经保证空集合序列化成 []，但客户端不该把整个界面押在这上面 ——
 * 拿到 null 之后一个 .length 就是白屏。
 */
export function listCommands(q: ListQuery = {}): Promise<ListResult> {
  const url = new URL('/api/commands', location.origin)
  if (q.q) url.searchParams.set('q', q.q)
  if (q.cwd) url.searchParams.set('cwd', q.cwd)
  if (q.failed) url.searchParams.set('failed', 'true')
  if (q.pinned) url.searchParams.set('pinned', 'true')
  if (q.limit) url.searchParams.set('limit', String(q.limit))
  if (q.before) url.searchParams.set('before', String(q.before))
  return json<ListResult>(url.toString()).then((r) => ({
    items: r.items ?? [],
    next_before: r.next_before ?? null,
  }))
}

export function patchCommand(
  id: number,
  patch: { pinned?: boolean; label?: string | null; pin_order?: number },
): Promise<void> {
  return json<void>(`/api/commands/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** 批量重排：一次提交所有受影响的项，避免中间态出现重复的 pin_order。 */
export function reorderCommands(items: { id: number; pin_order: number }[]): Promise<void> {
  return json<void>('/api/commands', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
}

export function deleteCommand(id: number): Promise<void> {
  return json<void>(`/api/commands/${id}`, { method: 'DELETE' })
}

/** 清空全部非置顶历史。必须显式带 pinned=false —— 整表删除不提供。 */
export function clearHistory(): Promise<{ deleted: number; kept_pinned: number }> {
  return json<{ deleted: number; kept_pinned: number }>('/api/commands?pinned=false', {
    method: 'DELETE',
  })
}

export function newSnippet(text: string, label?: string): Promise<{ id: number }> {
  return json<{ id: number }>('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, label: label ?? null }),
  })
}

/** 按天分组，用于历史面板。 */
export function groupByDay(items: CommandRecord[], now = Date.now()): [string, CommandRecord[]][] {
  const groups = new Map<string, CommandRecord[]>()
  for (const it of items) {
    const label = dayLabel(it.started_at, now)
    const arr = groups.get(label)
    if (arr) arr.push(it)
    else groups.set(label, [it])
  }
  return [...groups.entries()]
}

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ts >= startOfToday) return '今天'
  if (ts >= startOfToday - 86_400_000) return '昨天'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 超长命令中间省略 —— 保留开头【和结尾】。
 *
 * `docker logs -f …-web-1` 比 `docker logs -f cont…` 有用得多。
 */
export function ellipsize(text: string, max = 48): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 耗时的人类可读形式。 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}
