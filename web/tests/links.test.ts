/**
 * UT-links-1 (AC-5.19, ADR-0053 §1): URLs in the terminal text. http and https only;
 * soft-wrapped rows form one logical line; trailing punctuation and unbalanced closing
 * brackets are trimmed; CJK text and punctuation end a URL; columns account for wide cells.
 */
import headless from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { describe, expect, it } from 'vitest'

import { linkAt, linksInRow, type FoundLink } from '../src/term/links'

const { Terminal } = headless
type HTerm = InstanceType<typeof Terminal>

async function term(cols: number, text: string): Promise<HTerm> {
  const t = new Terminal({ cols, rows: 10, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon() as unknown as Parameters<HTerm['loadAddon']>[0])
  t.unicode.activeVersion = '11'
  await new Promise<void>((r) => t.write(text, () => r()))
  return t
}

const texts = (ls: FoundLink[]) => ls.map((l) => l.text)

describe('linksInRow', () => {
  it('finds a URL and trims the sentence period', async () => {
    const t = await term(80, 'see https://example.com/a?b=1.')
    const ls = linksInRow(t.buffer.active, 0)
    expect(texts(ls)).toEqual(['https://example.com/a?b=1'])
    expect(ls[0]!.start).toEqual({ x: 4, y: 0 })
    expect(ls[0]!.end).toEqual({ x: 28, y: 0 })
  })

  it('keeps balanced parentheses and drops an unbalanced closing one', async () => {
    const t = await term(80, '(https://en.wikipedia.org/wiki/Foo_(bar)) [md](https://x.com/y)')
    expect(texts(linksInRow(t.buffer.active, 0))).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://x.com/y'])
  })

  it('trims trailing quotes and punctuation', async () => {
    const t = await term(80, `"https://a.example/x", 'http://b.example/y'; https://c.example/z!?`)
    expect(texts(linksInRow(t.buffer.active, 0))).toEqual(['https://a.example/x', 'http://b.example/y', 'https://c.example/z'])
  })

  it('ignores other schemes and a bare scheme', async () => {
    const t = await term(80, 'file:///etc/passwd javascript:alert(1) ftp://x.example http:// https://')
    expect(linksInRow(t.buffer.active, 0)).toEqual([])
  })

  it('stops at CJK text and punctuation, and counts wide cells', async () => {
    const t = await term(80, '链接：https://example.com/a，下一句')
    const ls = linksInRow(t.buffer.active, 0)
    expect(texts(ls)).toEqual(['https://example.com/a'])
    expect(ls[0]!.start).toEqual({ x: 6, y: 0 }) // 链 接 ： are two cells each
  })

  it('joins soft-wrapped rows into one link, found from any of its rows', async () => {
    const url = 'https://example.com/' + 'x'.repeat(90)
    const t = await term(40, `go ${url} now`)
    const buf = t.buffer.active
    expect(buf.getLine(1)!.isWrapped).toBe(true)
    for (const row of [0, 1, 2]) {
      const ls = linksInRow(buf, row)
      expect(texts(ls), `row ${row}`).toEqual([url])
      expect(ls[0]!.start).toEqual({ x: 3, y: 0 })
      expect(ls[0]!.end).toEqual({ x: (3 + url.length - 1) % 40, y: 2 })
    }
  })

  it('does not join rows separated by a real newline', async () => {
    const t = await term(80, 'https://a.example/x\r\nmore')
    expect(texts(linksInRow(t.buffer.active, 0))).toEqual(['https://a.example/x'])
    expect(linksInRow(t.buffer.active, 1)).toEqual([])
  })
})

describe('linkAt', () => {
  it('returns the link covering a cell, or null', async () => {
    const url = 'https://example.com/' + 'y'.repeat(30)
    const t = await term(40, `x ${url}`)
    const buf = t.buffer.active
    expect(linkAt(buf, 0, 0)).toBeNull() // "x"
    expect(linkAt(buf, 2, 0)?.text).toBe(url)
    expect(linkAt(buf, 5, 1)?.text).toBe(url) // on the wrapped row
    expect(linkAt(buf, 39, 1)).toBeNull() // past the end
  })
})
