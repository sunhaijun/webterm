import { describe, expect, it } from 'vitest'

import { linkKind, renderMarkdown, resolveRel, slugify } from '../src/files/markdown'
import { FILES_MAX_KEY, MD_SIZE_KEY, MD_SIZES, readFilesMax, readMdSize, stepMdSize, writeFilesMax, writeMdSize } from '../src/ui/prefs'

/** Renders into a detached element, so assertions look at the DOM the page would get. */
function dom(src: string, dir = '/home/u/proj'): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = renderMarkdown(src, dir)
  return el
}

describe('UT-md-1 Markdown previews (AC-9.14)', () => {
  it('renders headings, lists, tables and code', () => {
    const el = dom('# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\ncode <b>\n```\n\n~~gone~~')
    expect(el.querySelector('h1')?.textContent).toBe('Title')
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('table td')?.textContent).toBe('1')
    expect(el.querySelector('pre code')?.textContent).toBe('code <b>\n')
    expect(el.querySelector('s')?.textContent).toBe('gone')
  })

  it('raw HTML stays text and creates no element', () => {
    const el = dom('<script>window.__md=1</script>\n\n<img src=x onerror="window.__md=2">\n\ninline <iframe src="/"></iframe> too')
    expect(el.querySelector('script, img, iframe')).toBeNull()
    expect(el.textContent).toContain('<script>window.__md=1</script>')
    expect(el.textContent).toContain('<iframe src="/"></iframe>')
  })

  it('links: only http(s), mailto, anchors and relative paths', () => {
    const el = dom(
      '[js](javascript:alert(1)) [data](data:text/html,x) [file](file:///etc/passwd) [vb](vbscript:x) [proto](//evil.example/x)\n\n' +
        '[web](https://example.com/) [mail](mailto:a@b.c) [next](#next-steps) [other](notes/other.md)',
    )
    const links = [...el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])
    expect(links).toEqual([
      ['web', 'https://example.com/', '_blank', 'noopener noreferrer'],
      ['mail', 'mailto:a@b.c', null, null],
      ['next', '#next-steps', null, null],
      ['other', 'notes/other.md', null, null],
    ])
    expect(el.textContent).toContain('[js](javascript:alert(1))')
  })

  it('bare URLs link only with a scheme; file names never become domains', () => {
    const el = dom('see https://example.com/a and notes.md or www.example.com')
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a'])
  })

  it('images: relative from the agent, remote as a link, nothing else loads', () => {
    const el = dom('![shot](img/shot%201.png) ![remote](https://example.com/x.png) ![inline](data:image/png;base64,AAAA)', '/home/u/proj')
    const imgs = [...el.querySelectorAll('img')]
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([`/api/fs/raw?path=${encodeURIComponent('/home/u/proj/img/shot 1.png')}`])
    expect(imgs[0]!.getAttribute('alt')).toBe('shot')
    const a = el.querySelector('a')!
    expect([a.textContent, a.getAttribute('href'), a.getAttribute('rel')]).toEqual(['remote', 'https://example.com/x.png', 'noopener noreferrer'])
    expect(el.textContent).toContain('inline')
  })

  it('headings get prefixed GitHub-style ids, repeats numbered', () => {
    const el = dom('## Next Steps!\n\n## Next Steps\n\n### 中文 标题')
    expect([...el.querySelectorAll('h2, h3')].map((h) => h.id)).toEqual(['md-next-steps', 'md-next-steps-1', 'md-中文-标题'])
    expect(slugify(' A.b, C_d ')).toBe('ab-c_d')
  })

  it('link kinds and relative paths', () => {
    expect(linkKind('https://x')).toBe('web')
    expect(linkKind('HTTP://x')).toBe('web')
    expect(linkKind('mailto:x')).toBe('mail')
    expect(linkKind('#a')).toBe('anchor')
    expect(linkKind('a/b.md')).toBe('rel')
    expect(linkKind('../a')).toBe('rel')
    expect(linkKind('/etc/hosts')).toBe('rel')
    expect(linkKind('//evil.example/x')).toBeNull()
    expect(linkKind(' javascript:x')).toBeNull()
    expect(linkKind('')).toBeNull()
    expect(resolveRel('/home/u/proj/docs', '../README.md#intro')).toBe('/home/u/proj/README.md')
    expect(resolveRel('/home/u/proj', 'notes/a%20b.md?x=1')).toBe('/home/u/proj/notes/a b.md')
    expect(resolveRel('/home/u/proj', '/etc/hosts')).toBe('/etc/hosts')
    expect(resolveRel('/a', '../../..')).toBe('/')
    expect(resolveRel('/a', './b/./c')).toBe('/a/b/c')
  })
})

describe('UT-files-7 maximize is remembered per device (AC-9.13)', () => {
  it('reads what was written; anything else is not maximized', () => {
    localStorage.removeItem(FILES_MAX_KEY)
    expect(readFilesMax()).toBe(false)
    writeFilesMax(true)
    expect(readFilesMax()).toBe(true)
    writeFilesMax(false)
    expect(readFilesMax()).toBe(false)
    localStorage.setItem(FILES_MAX_KEY, 'yes')
    expect(readFilesMax()).toBe(false)
  })
})

describe('UT-files-8 Markdown text size (AC-9.15)', () => {
  it('steps through eight sizes and stops at the ends', () => {
    expect(MD_SIZES).toEqual([12, 13, 14, 15, 17, 19, 21, 24])
    expect(stepMdSize(15, 1)).toBe(17)
    expect(stepMdSize(15, -1)).toBe(14)
    expect(stepMdSize(24, 1)).toBe(24)
    expect(stepMdSize(12, -1)).toBe(12)
    expect(stepMdSize(16, 1)).toBe(17)
    expect(stepMdSize(16, -1)).toBe(15)
    let px = 12
    for (let i = 0; i < 7; i++) px = stepMdSize(px, 1)
    expect(px).toBe(24)
  })

  it('remembers a step; anything else reads as 15', () => {
    localStorage.removeItem(MD_SIZE_KEY)
    expect(readMdSize()).toBe(15)
    writeMdSize(21)
    expect(readMdSize()).toBe(21)
    for (const bad of ['16', '30', 'big', '']) {
      localStorage.setItem(MD_SIZE_KEY, bad)
      expect(readMdSize()).toBe(15)
    }
  })
})
