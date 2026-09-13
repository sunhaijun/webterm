import { describe, expect, it } from 'vitest'

import { type FollowState, OutputQueue, type Parked } from '../src/term/outputqueue'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

/** 同步调度器：把回调攒起来，测试自己决定"下一帧"何时到。 */
function manualScheduler() {
  const pending: (() => void)[] = []
  return {
    schedule: (fn: () => void) => void pending.push(fn),
    tick: () => {
      const fns = pending.splice(0)
      for (const f of fns) f()
    },
  }
}

describe('OutputQueue：按帧合并 + 回看时暂停跟随', () => {
  it('跟随中：同一帧内的多个包合成一次写入，顺序不变', () => {
    const writes: string[] = []
    const s = manualScheduler()
    const q = new OutputQueue((d) => writes.push(dec(d)), { schedule: s.schedule })
    expect(q.push(enc('a'))).toBe('batched')
    expect(q.push(enc('b'))).toBe('batched')
    expect(q.push(enc('c'))).toBe('batched')
    expect(writes).toEqual([])
    s.tick()
    expect(writes).toEqual(['abc'])
    // 下一帧另起一批
    q.push(enc('d'))
    s.tick()
    expect(writes).toEqual(['abc', 'd'])
  })

  it('滚上去：只入队不写，报告攒了多少；回到底部一次写完，不丢不重', () => {
    const writes: string[] = []
    const parked: (Parked | null)[] = []
    const s = manualScheduler()
    const q = new OutputQueue((d) => writes.push(dec(d)), { schedule: s.schedule, onState: (st) => parked.push(st.parked) })
    q.setFollowing(false)
    expect(q.push(enc('line1\nline2\n'))).toBe('parked')
    expect(q.push(enc('line3\n'))).toBe('parked')
    s.tick()
    expect(writes, '暂停期间不写').toEqual([])
    expect(q.parked).toEqual({ lines: 3, bytes: 18 })
    expect(parked.at(-1)).toEqual({ lines: 3, bytes: 18 })
    expect(q.setFollowing(true), '回到底部要真的写了').toBe(true)
    expect(writes).toEqual(['line1\nline2\nline3\n'])
    expect(q.parked).toBeNull()
    expect(parked.at(-1)).toBeNull()
  })

  it('离开底部立刻通知 following=false（还没有新输出也通知 —— 提示条要写「回到底部」）', () => {
    const states: FollowState[] = []
    const q = new OutputQueue(() => {}, { schedule: () => {}, onState: (s) => states.push(s) })
    expect(q.state).toEqual({ following: true, parked: null })
    q.setFollowing(false)
    expect(states.at(-1)).toEqual({ following: false, parked: null })
    q.push(enc('x\n'))
    expect(states.at(-1)).toEqual({ following: false, parked: { lines: 1, bytes: 2 } })
    q.setFollowing(true)
    expect(states.at(-1)).toEqual({ following: true, parked: null })
    // 重复设置同一状态不重复通知
    const n = states.length
    q.setFollowing(true)
    expect(states.length).toBe(n)
  })

  it('强制写入后提示条计数不清零 —— 那些行用户还没看到', () => {
    const writes: string[] = []
    const q = new OutputQueue((d) => writes.push(dec(d)), { maxLines: 2, schedule: () => {} })
    q.setFollowing(false)
    q.push(enc('1\n'))
    q.push(enc('2\n'))
    expect(q.push(enc('3\n'))).toBe('flushed')
    expect(writes).toEqual(['1\n2\n3\n'])
    expect(q.parked, '写出去了但计数保留').toEqual({ lines: 3, bytes: 6 })
    expect(q.push(enc('4\n')), '队列清空后重新开始攒').toBe('parked')
    expect(q.parked).toEqual({ lines: 4, bytes: 8 })
    q.setFollowing(true)
    expect(writes).toEqual(['1\n2\n3\n', '4\n'])
    expect(q.parked).toBeNull()
  })

  it('攒过上限就强制写入，视口不由队列干涉', () => {
    const writes: string[] = []
    const q = new OutputQueue((d) => writes.push(dec(d)), { maxLines: 2, schedule: () => {} })
    q.setFollowing(false)
    q.push(enc('1\n'))
    q.push(enc('2\n'))
    expect(writes).toEqual([])
    expect(q.push(enc('3\n')), '第 3 行超过 maxLines=2').toBe('flushed')
    expect(writes).toEqual(['1\n2\n3\n'])
    expect(q.isFollowing, '强制写入不改变跟随状态').toBe(false)
  })

  it('字节上限同样触发', () => {
    const writes: string[] = []
    const q = new OutputQueue((d) => writes.push(dec(d)), { maxBytes: 4, schedule: () => {} })
    q.setFollowing(false)
    q.push(enc('abc'))
    expect(q.push(enc('de'))).toBe('flushed')
    expect(writes).toEqual(['abcde'])
  })

  it('drain 立刻写入（回放到达前保证顺序）；clear 丢弃', () => {
    const writes: string[] = []
    const q = new OutputQueue((d) => writes.push(dec(d)), { schedule: () => {} })
    q.setFollowing(false)
    q.push(enc('x'))
    q.drain()
    expect(writes).toEqual(['x'])
    q.push(enc('y'))
    q.clear()
    q.setFollowing(true)
    expect(writes, 'clear 之后没有东西可写').toEqual(['x'])
  })
})
