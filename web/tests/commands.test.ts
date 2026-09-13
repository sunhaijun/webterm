/** 历史面板的格式化。 */
import { describe, expect, it } from 'vitest'

import { dayLabel, ellipsize, formatDuration, groupByDay, type CommandRecord } from '../src/commands/api'

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
