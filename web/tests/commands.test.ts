/** 命令面板的模糊匹配与历史面板的格式化。 */
import { describe, expect, it } from 'vitest'

import { dayLabel, ellipsize, formatDuration, groupByDay, type CommandRecord } from '../src/commands/api'
import { fuzzyMatch, rankScore, recencyWeight } from '../src/commands/fuzzy'

describe('子序列模糊匹配', () => {
  it('按子序列匹配，不是子串', () => {
    expect(fuzzyMatch('gtr', 'go test -run')).not.toBeNull()
    // 子序列匹配意味着 "gtr" 也能打中 "git rebase"（g-i-t-空格-r），
    // 这是设计如此 —— 靠打分把更像的排前面，而不是靠匹配与否做筛选
    expect(fuzzyMatch('gtr', 'git rebase')).not.toBeNull()
    expect(fuzzyMatch('gtr', 'ls -la')).toBeNull()
  })

  it('不匹配时返回 null', () => {
    expect(fuzzyMatch('xyz', 'go test')).toBeNull()
    expect(fuzzyMatch('tg', 'go test')).toBeNull() // 顺序不对
  })

  it('空 query 视为匹配', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('不区分大小写', () => {
    expect(fuzzyMatch('GT', 'go test')).not.toBeNull()
    expect(fuzzyMatch('gt', 'GO TEST')).not.toBeNull()
  })

  it('词首匹配得分更高', () => {
    // "gt" 打在 "go test" 的两个词首上，比打在 "agtx" 中间强
    const wordStart = fuzzyMatch('gt', 'go test')!
    const middle = fuzzyMatch('gt', 'agtx')!
    expect(wordStart.score).toBeGreaterThan(middle.score)
  })

  it('精确连续匹配要压过攒词首奖励的散装匹配', () => {
    // "t-e-s-t" 的每个字符都跟在分隔符后面，能攒一堆词首奖励。
    // 但用户敲 test 时想要的显然是 test，所以连续奖励必须更重。
    const consecutive = fuzzyMatch('test', 'test')!
    const scattered = fuzzyMatch('test', 't-e-s-t')!
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })

  it('给出命中位置，方便高亮', () => {
    const m = fuzzyMatch('gt', 'go test')!
    expect(m.positions).toEqual([0, 3])
  })

  it('实际场景：go test 应当排在 git status 前面', () => {
    const a = fuzzyMatch('got', 'go test ./...')
    const b = fuzzyMatch('got', 'git log --oneline')
    expect(a).not.toBeNull()
    if (b) expect(a!.score).toBeGreaterThan(b.score)
  })
})

describe('时间衰减', () => {
  const now = Date.now()

  it('刚跑过的权重最高', () => {
    expect(recencyWeight(now, now)).toBeCloseTo(1)
  })

  it('半衰期 7 天', () => {
    expect(recencyWeight(now - 7 * 86_400_000, now)).toBeCloseTo(0.5, 2)
  })

  it('越久权重越低，但不为负', () => {
    const old = recencyWeight(now - 90 * 86_400_000, now)
    expect(old).toBeGreaterThan(0)
    expect(old).toBeLessThan(0.01)
  })
})

describe('命令面板排序', () => {
  const now = Date.now()

  it('匹配度相同时，最近跑过的排前面', () => {
    const m = fuzzyMatch('gt', 'go test')!
    const fresh = rankScore(m, now, now)
    const stale = rankScore(m, now - 30 * 86_400_000, now)
    expect(fresh).toBeGreaterThan(stale)
  })

  it('得分为负的匹配也不该被时间衰减反转顺序', () => {
    // 平移到正区间之后再乘衰减，否则越旧反而越靠前
    const weak = fuzzyMatch('t', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaat')!
    expect(rankScore(weak, now, now)).toBeGreaterThan(rankScore(weak, now - 60 * 86_400_000, now))
  })
})

describe('历史面板的展示', () => {
  const mk = (over: Partial<CommandRecord>): CommandRecord => ({
    id: 1,
    text: 'ls',
    session_name: 's',
    cwd: '/x',
    exit_code: 0,
    started_at: Date.now(),
    duration_ms: 100,
    pinned: false,
    label: null,
    pin_order: null,
    ...over,
  })

  it('按天分组', () => {
    const now = new Date('2026-09-06T12:00:00').getTime()
    const items = [
      mk({ id: 1, started_at: now - 3600_000 }),
      mk({ id: 2, started_at: now - 26 * 3600_000 }),
      mk({ id: 3, started_at: now - 200 * 3600_000 }),
    ]
    const groups = groupByDay(items, now)
    expect(groups[0]![0]).toBe('今天')
    expect(groups[1]![0]).toBe('昨天')
    expect(groups[2]![0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('未完成的命令耗时显示 —', () => {
    // shell 在 133;D 之前死了，exit_code / duration_ms 永久为 NULL
    expect(formatDuration(null)).toBe('—')
  })

  it('耗时格式', () => {
    expect(formatDuration(120)).toBe('120ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(125_000)).toBe('2m5s')
  })

  it('超长命令【中间】省略，保留开头和结尾', () => {
    // docker logs -f …-web-1 比 docker logs -f cont… 有用得多
    const long = 'docker logs -f myproject-production-web-1'
    const short = ellipsize(long, 24)
    expect(short.length).toBeLessThanOrEqual(24)
    expect(short.startsWith('docker')).toBe(true)
    expect(short.endsWith('web-1')).toBe(true)
    expect(short).toContain('…')
  })

  it('不够长就不省略', () => {
    expect(ellipsize('ls -la', 48)).toBe('ls -la')
  })
})

describe('日期标签', () => {
  it('今天 / 昨天 / 更早', () => {
    const now = new Date('2026-09-06T12:00:00').getTime()
    expect(dayLabel(now - 1000, now)).toBe('今天')
    expect(dayLabel(now - 20 * 3600_000, now)).toBe('昨天')
    expect(dayLabel(now - 100 * 3600_000, now)).toMatch(/^\d{4}-/)
  })
})
