/**
 * Markdown previews (ADR-0060 §2). markdown-it with raw HTML off, so tags in a file come
 * out as text; links only to http(s), mailto, #anchors and relative paths; images only from
 * the agent. This module is loaded the first time a Markdown file opens (its own chunk).
 *
 * The output is the one HTML string the page inserts. Clicks on it are handled by the file
 * sheet with one listener (`linkKind`, `resolveRel`), never by inline handlers, and the
 * page's CSP (`script-src 'self'`) would stop any that slipped in.
 */
import MarkdownIt from 'markdown-it'

import { rawUrl } from './fs'

export type LinkKind = 'web' | 'mail' | 'anchor' | 'rel'

/** What a link points at, or null for anything that must stay plain text. */
export function linkKind(href: string): LinkKind | null {
  const h = href.trim()
  if (h === '') return null
  if (h.startsWith('#')) return 'anchor'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)
  if (!scheme) return h.startsWith('//') ? null : 'rel' // protocol-relative URLs leave the agent
  switch (scheme[1]!.toLowerCase()) {
    case 'http':
    case 'https':
      return 'web'
    case 'mailto':
      return 'mail'
    default:
      return null
  }
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A relative link or image against the file's folder: query and anchor dropped, %-escapes decoded, `.` and `..` folded. */
export function resolveRel(dir: string, href: string): string {
  const bare = href.replace(/[?#].*$/, '')
  const path = decode(bare)
  const parts = (path.startsWith('/') ? path : `${dir}/${path}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return '/' + out.join('/')
}

/** GitHub-style heading id: lowercased, punctuation dropped, spaces to `-`. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Heading ids carry this prefix so they never collide with the page's own (or clobber window properties). */
export const ID_PREFIX = 'md-'

/** The element id a `#anchor` link points at. */
export function anchorId(href: string): string {
  return ID_PREFIX + decode(href.replace(/^#/, ''))
}

/** Per render: the file's folder and the heading ids used so far. */
type Env = { dir: string; slugs: Map<string, number> } & Record<string, unknown>

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })
// Only explicit http(s) URLs become links: `notes.md` must not turn into a link to a .md domain
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
md.validateLink = (url: string) => linkKind(url) !== null

const esc = md.utils.escapeHtml

type Tok = { attrGet(name: string): string | number | null }
const attr = (t: Tok, name: string): string => String(t.attrGet(name) ?? '')

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const t = tokens[idx]!
  if (linkKind(attr(t, 'href')) === 'web') {
    t.attrSet('target', '_blank')
    t.attrSet('rel', 'noopener noreferrer')
  }
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.image = (tokens, idx, _options, e) => {
  const env = e as unknown as Env
  const t = tokens[idx]!
  const src = attr(t, 'src')
  const alt = t.content
  switch (linkKind(src)) {
    case 'rel':
      return `<img src="${esc(rawUrl(resolveRel(env.dir, src)))}" alt="${esc(alt)}" loading="lazy">`
    case 'web':
      // Not loaded: a third party would learn when and from where the file was read
      return `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(alt || src)}</a>`
    default:
      return esc(alt)
  }
}

md.renderer.rules.heading_open = (tokens, idx, options, e, self) => {
  const env = e as unknown as Env
  const slug = slugify(tokens[idx + 1]?.content ?? '')
  const n = env.slugs.get(slug) ?? 0
  env.slugs.set(slug, n + 1)
  tokens[idx]!.attrSet('id', ID_PREFIX + (n === 0 ? slug : `${slug}-${n}`))
  return self.renderToken(tokens, idx, options)
}

/** Renders Markdown found in folder `dir` to HTML. */
export function renderMarkdown(src: string, dir: string): string {
  const env: Env = { dir, slugs: new Map() }
  return md.render(src, env)
}
