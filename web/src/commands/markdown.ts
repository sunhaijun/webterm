/**
 * 极简 Markdown → HTML（ADR-0012 γ）。
 *
 * 只认 claude / codex 回答里常见的那一小撮：标题、段落、无序/有序列表、围栏代码、
 * 行内代码、粗体/斜体、链接（只放 http/https）、引用、分隔线、表格。
 * 输出全部经过转义，链接 href 白名单 —— 转录来自模型输出，当不可信内容处理。
 * 不引 markdown 库：40KB 换这点功能不值，而且要的就是可控。
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const safeHref = (h: string) => (/^https?:\/\//i.test(h) ? esc(h) : null)

/** 行内：代码、粗体、斜体、链接。先切出行内代码，剩下的再处理，避免代码里的 * 被当成强调。 */
export function renderInline(text: string): string {
  const out: string[] = []
  const parts = text.split(/(`[^`]+`)/)
  for (const p of parts) {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      out.push(`<code>${esc(p.slice(1, -1))}</code>`)
      continue
    }
    let s = esc(p)
    // 链接目标允许一层括号（javascript:alert(1) 这类要整个吃掉再丢弃）
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, t: string, h: string) => {
      const href = safeHref(h)
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>` : t
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    out.push(s)
  }
  return out.join('')
}

const FENCE = /^(`{3,}|~{3,})\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const UL = /^(\s*)[-*+]\s+(.*)$/
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 整段 Markdown → HTML。 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(' '))}</p>`)
      para = []
    }
  }
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flushPara()
      const mark = fence[1]!
      const lang = fence[2] ?? ''
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith(mark)) buf.push(lines[i++]!)
      i++ // 闭合行（没有也无所谓：吃到末尾）
      const cls = lang ? ` class="lang-${esc(lang)}"` : ''
      out.push(`<pre><code${cls}>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flushPara()
      const level = h[1]!.length
      out.push(`<h${level}>${renderInline(h[2]!)}</h${level}>`)
      i++
      continue
    }
    if (HR.test(line)) {
      flushPara()
      out.push('<hr>')
      i++
      continue
    }
    if (line.startsWith('>')) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) buf.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flushPara()
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') rows.push(splitRow(lines[i++]!))
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('')
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`)
      continue
    }
    const ul = UL.exec(line)
    const ol = OL.exec(line)
    if (ul || ol) {
      flushPara()
      const ordered = !!ol
      const re = ordered ? OL : UL
      const items: string[] = []
      while (i < lines.length) {
        const m = re.exec(lines[i]!)
        if (!m) break
        let text = ordered ? m[3]! : m[2]!
        i++
        // 缩进的续行归到本项
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !re.test(lines[i]!) && !FENCE.test(lines[i]!)) {
          text += ' ' + lines[i++]!.trim()
        }
        items.push(`<li>${renderInline(text)}</li>`)
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    para.push(line.trim())
    i++
  }
  flushPara()
  return out.join('\n')
}
