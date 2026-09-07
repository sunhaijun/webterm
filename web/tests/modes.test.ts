/** UT-mode-1 / UT-mode-2：模式状态机的转移表、running 去抖、locked 行为。 */
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

describe('UT-mode-2 锁定', () => {
  it('手动切换后自动切换暂停', () => {
    const { m } = machine()
    m.toggleManual()
    expect(m.current).toEqual({ mode: 'raw', locked: true })

    m.onPrompt('input')
    vi.advanceTimersByTime(1000)
    expect(m.current.mode, 'locked 之后不该被 prompt 改动').toBe('raw')
  })

  it('解锁后立即按最近的 prompt 状态重算', () => {
    const { m } = machine()
    m.onPrompt('running')
    vi.advanceTimersByTime(RAW_DEBOUNCE_MS)
    m.setManual('composer')
    expect(m.current).toEqual({ mode: 'composer', locked: true })

    m.unlock()
    expect(m.current, '最近的 prompt 是 running，解锁后应当回到 raw').toEqual({
      mode: 'raw',
      locked: false,
    })
  })

  it('锁定期间的 running 去抖不该在解锁后偷偷生效', () => {
    const { m } = machine()
    m.setManual('composer')
    m.onPrompt('running')
    vi.advanceTimersByTime(1000)
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

    // 之后的 prompt 消息不再改变模式（本来也不会有）
    m.onPrompt('running')
    vi.advanceTimersByTime(1000)
    expect(m.current.mode).toBe('composer')
  })

  it('降级时用户仍然可以手动切到 Raw —— 否则 vim 就没法用了', () => {
    const { m } = machine()
    m.onIntegration('inactive')
    m.setManual('raw')
    expect(m.current.mode).toBe('raw')
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
  it('reset 清掉锁定 —— 对上一个会话的手动选择不该跨会话生效', () => {
    const { m } = machine()
    m.setManual('raw')
    m.reset()
    expect(m.current).toEqual({ mode: 'composer', locked: false })
  })
})
