/**
 * The file browser's logic without UI (ADR-0059): `/api/fs/*` requests, ordering, the
 * path row, formatting, what kind of preview a file gets, and the path pasted by
 * Send to session. The sheets are in `browser.tsx`.
 */

export interface Entry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  /** Unix milliseconds. */
  mtime: number
  /** The name isn't valid UTF-8: shown, but it can't be addressed (ADR-0059 §3). */
  bad_name?: boolean
}

export interface Listing {
  path: string
  entries: Entry[]
  total: number
}

/** A failed request: `status` 0 = no answer; `code` from the error body when there was one. */
export interface Failure {
  ok: false
  status: number
  code: string
}

export type Result<T> = ({ ok: true } & T) | Failure

// ---------- Paths ----------

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** The parent folder; `/` is its own parent. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || '/'
}

export interface Crumb {
  label: string
  path: string
}

/** The path row (AC-9.3): `~` for the home directory and everything under it, else `/` first. */
export function crumbs(path: string, home: string | null): Crumb[] {
  const out: Crumb[] = []
  let rest = path
  let at = ''
  if (home && home !== '/' && (path === home || path.startsWith(home + '/'))) {
    out.push({ label: '~', path: home })
    rest = path.slice(home.length)
    at = home
  } else {
    out.push({ label: '/', path: '/' })
  }
  for (const part of rest.split('/')) {
    if (part === '') continue
    at = `${at}/${part}`
    out.push({ label: part, path: at })
  }
  return out
}

/**
 * The path as Send to session pastes it (ADR-0059 §4): a backslash before every character
 * other than letters (any script), digits and `_ . / , : @ % + = -`, as a local terminal
 * types a dropped file, which claude turns into an attachment and a shell reads correctly.
 *
 * null for a path with a control character (C0, DEL, C1): it isn't pasted at all. Pasted
 * raw, an ESC could end the bracketed paste early and a newline would press Enter, so a
 * file named by a cloned repository or an archive could type and run a command.
 */
export function escapePath(path: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(path)) return null
  return path.replace(/[^\p{L}\p{N}_./,:@%+=-]/gu, (c) => `\\${c}`)
}

/** The agent's rule for one name (http-api.md#files), checked before asking it. */
export function validName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name !== '' && name !== '.' && name !== '..' && !/[/\x00-\x1f\x7f]/.test(name) && new TextEncoder().encode(name).length <= 255
}

// ---------- Where it opens (AC-9.2) ----------

export interface Visit {
  /** The session's cwd when the browser was closed. */
  cwd: string
  /** The folder it was showing. */
  dir: string
}

/** Back where you were if the session hasn't changed folder since; otherwise its cwd, or home, or `/`. */
export function startDir(visit: Visit | undefined, cwd: string | null | undefined, home: string | null): string {
  const at = cwd || home || '/'
  return visit && visit.cwd === at ? visit.dir : at
}

// ---------- Ordering and formatting ----------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders, files, hidden folders, hidden files; natural and case-insensitive within each (AC-9.3). */
export function sortEntries(entries: Entry[]): Entry[] {
  const rank = (e: Entry) => (e.name.startsWith('.') ? 2 : 0) + (e.type === 'dir' ? 0 : 1)
  return [...entries].sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function matches(name: string, filter: string): boolean {
  return filter === '' || name.toLowerCase().includes(filter.toLowerCase())
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:MM` today, `MM-DD` earlier this year, `YYYY-MM-DD` before that, in local time. */
export function formatTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const t = new Date(now)
  if (d.getFullYear() !== t.getFullYear()) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getMonth() !== t.getMonth() || d.getDate() !== t.getDate()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatFullTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------- Previews (AC-9.5) ----------

export type PreviewKind = 'image' | 'video' | 'audio' | 'none' | 'text'

const KIND: Record<string, PreviewKind> = {}
for (const e of 'png jpg jpeg gif webp avif bmp ico svg'.split(' ')) KIND[e] = 'image'
for (const e of 'mp4 m4v webm mov ogv'.split(' ')) KIND[e] = 'video'
for (const e of 'mp3 m4a aac wav flac ogg oga opus'.split(' ')) KIND[e] = 'audio'
KIND.pdf = 'none'

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** By extension; `text` means "read the start and look for a NUL byte". */
export function previewKind(name: string): PreviewKind {
  return KIND[extOf(name)] ?? 'text'
}

/** The type the agent serves for a name (http-api.md#files), for `canShare` before the fetch. */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/plain', csv: 'text/plain',
}

export function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? 'application/octet-stream'
}

/** How much of a text file is shown, from the start or the end. */
export const TEXT_BYTES = 512 * 1024
/** Where a NUL byte makes a file binary. */
export const SNIFF_BYTES = 8 * 1024
/** The largest file Share fetches into memory; above it, Download. */
export const SHARE_MAX = 100 * 1024 * 1024

export function hasNul(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0)
}

/** Decodes a chunk for display; a tail starts after its first newline (the line before it is cut). */
export function decodeText(bytes: Uint8Array, tail: boolean): string {
  let b = bytes
  if (tail) {
    const nl = b.indexOf(10)
    if (nl >= 0) b = b.subarray(nl + 1)
  }
  return new TextDecoder('utf-8').decode(b)
}

// ---------- Requests ----------

export function rawUrl(path: string, download = false): string {
  return `/api/fs/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
}

async function failure(r: Response): Promise<Failure> {
  let code = ''
  try {
    code = String(((await r.json()) as { code?: unknown }).code ?? '')
  } catch {
    /* not JSON */
  }
  return { ok: false, status: r.status, code }
}

async function call<T>(input: string, init: RequestInit, want: number, parse: (r: Response) => Promise<T>): Promise<Result<T>> {
  try {
    const r = await fetch(input, { credentials: 'same-origin', ...init })
    if (r.status !== want) return await failure(r)
    return { ok: true, ...(await parse(r)) }
  } catch {
    return { ok: false, status: 0, code: '' }
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function listDir(path: string): Promise<Result<{ listing: Listing }>> {
  return call(`/api/fs/list?path=${encodeURIComponent(path)}`, {}, 200, async (r) => ({ listing: (await r.json()) as Listing }))
}

export function makeDir(dir: string, name: string): Promise<Result<object>> {
  return call('/api/fs/mkdir', json({ dir, name }), 201, async () => ({}))
}

export function renameEntry(path: string, name: string): Promise<Result<{ path: string }>> {
  return call('/api/fs/rename', json({ path, name }), 200, async (r) => ({ path: String(((await r.json()) as { path: string }).path) }))
}

export function removeEntry(path: string): Promise<Result<object>> {
  return call(`/api/fs?path=${encodeURIComponent(path)}`, { method: 'DELETE' }, 204, async () => ({}))
}

/** Reads part of a file: the first `TEXT_BYTES`, or the last with `tail`. */
export async function readChunk(path: string, tail: boolean): Promise<Result<{ bytes: Uint8Array }>> {
  const range = tail ? `bytes=-${TEXT_BYTES}` : `bytes=0-${TEXT_BYTES - 1}`
  try {
    const r = await fetch(rawUrl(path), { credentials: 'same-origin', headers: { Range: range } })
    if (r.status !== 200 && r.status !== 206) return await failure(r)
    return { ok: true, bytes: new Uint8Array(await r.arrayBuffer()) }
  } catch {
    return { ok: false, status: 0, code: '' }
  }
}

/** The whole file as a `File`, for the share sheet. */
export async function fetchFile(path: string): Promise<Result<{ file: File }>> {
  try {
    const r = await fetch(rawUrl(path), { credentials: 'same-origin' })
    if (r.status !== 200) return await failure(r)
    const blob = await r.blob()
    const type = (r.headers.get('Content-Type') ?? blob.type).split(';')[0]
    return { ok: true, file: new File([blob], baseName(path), { type }) }
  } catch {
    return { ok: false, status: 0, code: '' }
  }
}

export interface Uploaded {
  path: string
  name: string
}

/**
 * `POST /api/fs/upload` with the file as the body. XHR rather than fetch: fetch reports no
 * upload progress, and the button shows it (AC-9.8).
 */
export function uploadTo(dir: string, file: File, onProgress: (fraction: number) => void): Promise<Result<Uploaded>> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    x.onload = () => {
      let body: { path?: unknown; name?: unknown; code?: unknown } = {}
      try {
        body = JSON.parse(x.responseText)
      } catch {
        /* not JSON */
      }
      if (x.status === 201 && typeof body.path === 'string' && typeof body.name === 'string') resolve({ ok: true, path: body.path, name: body.name })
      else resolve({ ok: false, status: x.status, code: String(body.code ?? '') })
    }
    x.onerror = x.onabort = () => resolve({ ok: false, status: 0, code: '' })
    x.send(file)
  })
}

/** The toast for a failed request. */
export function failureText(f: Failure, what: string): string {
  if (f.code === 'exists') return `${what}: that name is taken`
  if (f.code === 'forbidden') return `${what}: permission denied`
  if (f.code === 'not_found') return `${what}: not found`
  if (f.code === 'bad_request') return `${what}: not allowed`
  if (f.status === 0) return `${what}: couldn't reach the agent`
  return `${what} failed`
}
