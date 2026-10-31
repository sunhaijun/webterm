/** 连接状态的文字（AC-2.10，session-ux.md §连接状态指示）。 */
import { describe, expect, it } from 'vitest'

import { formatBytes } from '../src/app/controller'
import { connLabel } from '../src/app/notices'

describe('conn-text', () => {
  it('在线就是「在线」（RTT 放进 wide 状态点的 title，不进 conn-text）', () => {
    expect(connLabel('online', {})).toBe('在线')
    expect(connLabel('online', { rttMs: 900 })).toBe('在线')
  })
  it('重连中带倒计时（向上取整到秒）', () => {
    expect(connLabel('reconnecting', { retryInMs: 2100 })).toBe('重连中 · 3s 后重试')
    expect(connLabel('reconnecting', { retryInMs: 0 })).toBe('重连中 · 0s 后重试')
    expect(connLabel('reconnecting', {})).toBe('重连中…')
  })
  it('其余状态都不是「在线」', () => {
    expect(connLabel('connecting', {})).toBe('连接中…')
    expect(connLabel('closed', {})).toBe('已断开')
  })
})

describe('「已恢复 · 补齐 N KB」的字节数', () => {
  it('B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(48 * 1024)).toBe('48.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
