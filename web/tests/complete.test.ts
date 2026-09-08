import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeChips } from '../src/input/chips'
import {
  completionText,
  isCommandPosition,
  shellEscape,
  splitToken,
  tokenAt,
  unescapeToken,
  wantsPath,
} from '../src/input/complete'

/**
 * 写态补全（ADR-0011 ③）：token 切分、路径判定、chips 组装。
 */
describe('tokenAt：光标左边那个词', () => {
  it('取光标左边连续的非空白', () => {
    expect(tokenAt('cd src/co', 9)).toEqual({ start: 3, end: 9, text: 'src/co' })
  })
  it('光标前是空白 → 空 token（要开始敲新的一个）', () => {
    expect(tokenAt('cd ', 3)).toEqual({ start: 3, end: 3, text: '' })
  })
  it('只看光标左边，右边不算', () => {
    expect(tokenAt('cat foo bar', 7)).toEqual({ start: 4, end: 7, text: 'foo' })
  })
  it('空输入', () => {
    expect(tokenAt('', 0)).toEqual({ start: 0, end: 0, text: '' })
  })
})

describe('wantsPath：什么时候值得去问路径', () => {
  const t = (v: string) => wantsPath(v, tokenAt(v, v.length))
  it('参数位都问', () => {
    expect(t('cd s')).toBe(true)
    expect(t('cat ')).toBe(true)
  })
  it('选项不问', () => {
    expect(t('ls -')).toBe(false)
    expect(t('git --no')).toBe(false)
  })
  it('命令位只有明确像路径的才问 —— gi 是想打 git，不是找 gi*', () => {
    expect(t('gi')).toBe(false)
    expect(t('./run')).toBe(true)
    expect(t('../x')).toBe(true)
    expect(t('/usr/b')).toBe(true)
    expect(t('~/pro')).toBe(true)
  })
  it('isCommandPosition 认前面只有空白', () => {
    expect(isCommandPosition('  git', tokenAt('  git', 5))).toBe(true)
    expect(isCommandPosition('a b', tokenAt('a b', 3))).toBe(false)
  })
})

describe('splitToken / 转义', () => {
  it('拆出已敲的目录部分', () => {
    expect(splitToken('src/co')).toEqual({ dirPrefix: 'src/', base: 'co' })
    expect(splitToken('co')).toEqual({ dirPrefix: '', base: 'co' })
    expect(splitToken('src/')).toEqual({ dirPrefix: 'src/', base: '' })
  })
  it('文件名里 shell 会误解的字符加反斜杠，正常名字原样', () => {
    expect(shellEscape('my file (1).txt')).toBe('my\\ file\\ \\(1\\).txt')
    expect(shellEscape('README.md')).toBe('README.md')
    expect(shellEscape("it's")).toBe("it\\'s")
  })
  it('目录补 /，文件补空格；目录前缀原样拼回去', () => {
    expect(completionText('src/', { name: 'commands', dir: true })).toBe('src/commands/')
    expect(completionText('', { name: 'a b.go', dir: false })).toBe('a\\ b.go ')
  })
  it('unescapeToken 还原用户敲的转义再去问服务端', () => {
    expect(unescapeToken('my\\ dir/')).toBe('my dir/')
  })
})

describe('computeChips：chips 的组装', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** 按 URL 路径分发的假 fetch。 */
  const stub = (routes: Record<string, unknown>) =>
    vi.stubGlobal('fetch', (input: string | URL) => {
      const u = new URL(String(input))
      const key = u.pathname
      const body = routes[key]
      if (body === undefined) return Promise.resolve(new Response('', { status: 404 }))
      return Promise.resolve(new Response(JSON.stringify(typeof body === 'function' ? body(u) : body)))
    })
  const pinned = [{ id: 1, text: 'make build', label: '构建', pinned: true } as never]

  it('输入框空着：快捷命令 + 同目录历史（去重、不重复快捷命令）', async () => {
    stub({
      '/api/commands': {
        items: [
          { text: 'make build', pinned: true },
          { text: 'git status', pinned: false },
          { text: 'git status', pinned: false },
          { text: 'npm test', pinned: false },
        ],
      },
    })
    const chips = await computeChips({ open: true, cwd: '/p', pinned, value: '', cursor: 0, tick: 0 })
    expect(chips).toEqual([
      { kind: 'pin', text: 'make build', label: '构建' },
      { kind: 'cmd', text: 'git status' },
      { kind: 'cmd', text: 'npm test' },
    ])
  })

  it('没有 cwd 就只有快捷命令（不知道"同目录"是哪个目录）', async () => {
    stub({ '/api/commands': { items: [{ text: 'x', pinned: false }] } })
    const chips = await computeChips({ open: true, cwd: '', pinned, value: '', cursor: 0, tick: 0 })
    expect(chips.map((c) => c.kind)).toEqual(['pin'])
  })

  it('有内容：路径补全在前，前缀历史在后，排除与输入完全相同的', async () => {
    stub({
      '/api/fs': (u: URL) => {
        expect(u.searchParams.get('cwd')).toBe('/p')
        expect(u.searchParams.get('path')).toBe('sr')
        return { items: [{ name: 'src', dir: true }, { name: 'srv.go', dir: false }] }
      },
      '/api/commands': (u: URL) => {
        expect(u.searchParams.get('prefix')).toBe('cd sr')
        return { items: [{ text: 'cd sr' }, { text: 'cd src/commands' }] }
      },
    })
    const chips = await computeChips({ open: true, cwd: '/p', pinned, value: 'cd sr', cursor: 5, tick: 0 })
    expect(chips).toEqual([
      { kind: 'path', text: 'src/', dir: true },
      { kind: 'path', text: 'srv.go ', dir: false },
      { kind: 'cmd', text: 'cd src/commands' },
    ])
  })

  it('命令位的普通单词不问路径，只有历史', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string | URL) => {
      const u = new URL(String(input))
      calls.push(u.pathname)
      return Promise.resolve(new Response(JSON.stringify({ items: [{ text: 'git log' }] })))
    })
    const chips = await computeChips({ open: true, cwd: '/p', pinned, value: 'gi', cursor: 2, tick: 0 })
    expect(calls).toEqual(['/api/commands'])
    expect(chips).toEqual([{ kind: 'cmd', text: 'git log' }])
  })

  it('接口挂了不影响别的：路径 500，历史照样出', async () => {
    vi.stubGlobal('fetch', (input: string | URL) => {
      const u = new URL(String(input))
      if (u.pathname === '/api/fs') return Promise.resolve(new Response('', { status: 500 }))
      return Promise.resolve(new Response(JSON.stringify({ items: [{ text: 'cd src' }] })))
    })
    const chips = await computeChips({ open: true, cwd: '/p', pinned, value: 'cd s', cursor: 4, tick: 0 })
    expect(chips).toEqual([{ kind: 'cmd', text: 'cd src' }])
  })
})
