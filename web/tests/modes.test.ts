/** UT-mode-1：模式状态机的转移表与 running 去抖（全自动，无手动锁定）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModeMachine, RAW_DEBOUNCE_MS, type ModeState } from '../src/input/modes'

function machine() {
  const seen: ModeState[] = []
  const m = new ModeMachine({ onChange: (s: ModeState) => seen.push(s) })
  m.onIntegration('active') // 默认让自动切换可用
  return { m, seen }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('UT-mode-1 自动切换', () => {
  it('默认是 Composer', () => {
    const { m } = machine()
    expect(m.current.mode).toBe('composer')
  })

  it('running → Raw（经 120ms 去抖）', () => {
    const { m } = machine()
    m.onPrompt('running')
    expect(m.current.mode, '去抖期内不该切').toBe('composer')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')
  })

  it('瞬间结束的命令不该闪一下 Raw', () => {
    // ls / echo 会产生 running → done 只隔几毫秒的序列
    const { m, seen } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(20)
    m.onPrompt('done')
    vi.advanceTimersByTime(500)
    expect(m.current.mode).toBe('composer')
    expect(seen.some((s) => s.mode === 'raw'), '中途闪过 Raw').toBe(false)
  })

  it('done / input → 立即切回 Composer，不去抖', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')

    m.onPrompt('done')
    // 切回必须【立即】，否则用户输入会被拖慢
    expect(m.current.mode).toBe('composer')
  })
})

describe('集成失效时的降级（AC-3.7）', () => {
  it('integration 变 inactive → 固定 Composer，自动切换禁用', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')

    m.onIntegration('inactive')
    expect(m.current.mode).toBe('composer')
    expect(m.autoAvailable).toBe(false)

    // 之后的 prompt 消息不再改变模式（终端区直送键仍然可用，与模式机无关）
    m.onPrompt('running')
    vi.advanceTimersByTime(1000)
    expect(m.current.mode).toBe('composer')
  })

  it('集成恢复后自动切换重新可用', () => {
    const { m } = machine()
    m.onIntegration('inactive')
    m.onIntegration('active')
    expect(m.autoAvailable).toBe(true)
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')
  })
})

describe('会话切换', () => {
  it('reset 回到 Composer —— 上一个会话的状态不跨会话生效', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')

    m.reset()
    expect(m.current).toEqual({ mode: 'composer' })
  })
})

describe('重连后重新对齐（协议 §4.2 的 prompt_state）', () => {
  it('离线期间命令跑完了 → 重连后回到 Composer', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')

    // 断线期间命令跑完了，那些 prompt 消息发给了零个订阅者就此丢掉。
    // 没有这次 resync 的话客户端会一直停在 Raw —— Composer 收起，
    // 用户连字都打不了。
    m.resync('input')
    expect(m.current.mode).toBe('composer')
  })

  it('离线期间命令还在跑 → 重连后仍是 Raw', () => {
    const { m } = machine()
    m.resync('running')
    expect(m.current.mode).toBe('raw')
  })

  it('prompt_state 为 null（集成不可用）时不动', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    expect(m.current.mode).toBe('raw')
    m.resync(null)
    expect(m.current.mode).toBe('raw')
  })
})
