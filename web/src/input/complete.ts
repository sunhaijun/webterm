/**
 * 写态的补全数据 —— ADR-0011 分片 ③。
 *
 * 两种 chip：整条命令（快捷命令 / 同目录历史 / 前缀匹配的历史）与路径
 * （补光标所在的 token）。它们都只是"点一下省掉一段打字"，不是智能提示。
 *
 * 路径 chip 就是 Tab 补全的触屏版：手机上没有 Tab，而目录名恰恰是最难打、
 * 最容易打错的东西。
 */

export interface Token {
  start: number
  end: number
  text: string
}

export type Chip =
  | { kind: 'pin' | 'cmd'; text: string; label?: string }
  | { kind: 'path'; text: string; dir: boolean }

/** 光标所在的 token：光标左边连续的非空白。只替换光标左边，右边的东西不动。 */
export function tokenAt(value: string, cursor: number): Token {
  const upto = value.slice(0, cursor)
  const m = /\S*$/.exec(upto)
  const text = m ? m[0] : ''
  return { start: cursor - text.length, end: cursor, text }
}

/** 是不是第一个词（命令位）：token 前面只有空白。 */
export function isCommandPosition(value: string, token: Token): boolean {
  return value.slice(0, token.start).trim() === ''
}

/**
 * 这个 token 值得去问路径吗？
 *
 * - 命令位只有明确像路径的才问（`./` `../` `/` `~`）—— 否则敲 `gi` 会被当成
 *   路径前缀去找，而用户想打的是 `git`
 * - 参数位都问；选项（`-x` / `--xx`）不问
 */
export function wantsPath(value: string, token: Token): boolean {
  const t = token.text
  if (t.startsWith('-')) return false
  if (isCommandPosition(value, token)) return /^(\.{1,2}\/|\/|~)/.test(t)
  return true
}

/** 把 token 拆成"已经敲出来的目录部分"与"正在敲的名字"。 */
export function splitToken(text: string): { dirPrefix: string; base: string } {
  const i = text.lastIndexOf('/')
  return i < 0 ? { dirPrefix: '', base: text } : { dirPrefix: text.slice(0, i + 1), base: text.slice(i + 1) }
}

/** 用户敲的 token 可能带着反斜杠转义（`my\ dir/`），问服务端之前还原。 */
export function unescapeToken(t: string): string {
  return t.replace(/\\(.)/g, '$1')
}

/** 只转义会让 shell 误解的字符；正常文件名原样。 */
export function shellEscape(name: string): string {
  return name.replace(/([ \t"'`$\\!&|;<>()*?[\]{}#^])/g, '\\$1')
}

/** 一条路径补全落到输入框里的样子：目录补 `/`（还能继续往下补），文件补一个空格。 */
export function completionText(dirPrefix: string, item: PathItem): string {
  return dirPrefix + shellEscape(item.name) + (item.dir ? '/' : ' ')
}

export interface PathItem {
  name: string
  dir: boolean
}

export interface PathResult {
  items: PathItem[]
}

/** `GET /api/fs` —— docs/30-protocol/http-api.md §路径补全。找不到目录就是空列表，不是错。 */
export async function fetchPaths(cwd: string, partial: string, signal?: AbortSignal): Promise<PathResult> {
  const url = new URL('/api/fs', location.origin)
  url.searchParams.set('cwd', cwd)
  url.searchParams.set('path', partial)
  const r = await fetch(url, { credentials: 'same-origin', signal })
  if (!r.ok) return { items: [] }
  const body = (await r.json()) as Partial<PathResult>
  return { items: body.items ?? [] }
}
