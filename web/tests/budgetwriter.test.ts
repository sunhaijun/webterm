import { describe, expect, it } from 'vitest'

import { BudgetWriter, WRITE_BUDGET } from '../src/term/budgetwriter'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)
const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill)

/** 同步调度器：把回调攒起来，测试自己决定"下一帧"何时到。 */
function manualScheduler() {
  const pending: (() => void)[] = []
  return {
    schedule: (fn: () => void) => void pending.push(fn),
    tick: () => {
      const fns = pending.splice(0)
      for (const f of fns) f()
    },
    get size() {
      return pending.length
    },
  }
}

describe('BudgetWriter：每帧至多一个预算，顺序绝不改（AC-5.16）', () => {
  it('UT-writer-1 小块直接写；有积压时排队，实时帧不许插到还没滴完的大块前面', () => {
    const writes: string[] = []
    const s = manualScheduler()
    const w = new BudgetWriter((d) => writes.push(dec(d)), { budget: 4, schedule: s.schedule })

    // 没有积压 + 不超预算 → 立刻写，不压帧（实时帧已经按帧合并过了）
    w.write(enc('ab'))
    expect(writes).toEqual(['ab'])

    // 大块：切片慢滴
    w.write(enc('0123456789'))
    expect(writes, '大块不在当前帧写完').toEqual(['ab'])
    // 大块还在滴，这时到达的小块必须排在它【后面】
    w.write(enc('LIVE'))

    s.tick()
    expect(writes).toEqual(['ab', '0123'])
    s.tick()
    expect(writes).toEqual(['ab', '0123', '4567'])
    // 【预算是每帧的总量，跨块累计】：这一帧写完大块剩下的 2 字节，还剩 2 字节预算，
    // 就接着写下一块的头 2 字节 —— 而不是"每帧一块"
    s.tick()
    expect(writes).toEqual(['ab', '0123', '4567', '89', 'LI'])
    s.tick()
    expect(writes.join(''), '顺序 = 入队顺序，一个字节不丢不重').toBe('ab0123456789LIVE')
    expect(w.pending).toBe(0)
  })

  it('UT-writer-2 预算是每帧的上限：每帧交出去的字节数不超预算，排完为止', () => {
    const sizes: number[] = []
    const s = manualScheduler()
    const budget = 100
    const w = new BudgetWriter((d) => sizes.push(d.length), { budget, schedule: s.schedule })

    w.write(bytes(1000))
    let frames = 0
    while (w.pending > 0) {
      const before = sizes.reduce((a, b) => a + b, 0)
      s.tick()
      const wrote = sizes.reduce((a, b) => a + b, 0) - before
      expect(wrote, `第 ${frames + 1} 帧写了 ${wrote} 字节`).toBeLessThanOrEqual(budget)
      frames++
      expect(frames, '不该滴不完').toBeLessThan(20)
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1000)
    expect(frames).toBe(10)
  })

  it('UT-writer-3 done 在这一块【全部】写完之后才调 —— 回放窗口不能在片与片之间断开', () => {
    const s = manualScheduler()
    const doneAt: number[] = []
    let wrote = 0
    // sink 模拟 xterm.write(data, cb)：解析完才回调
    const w = new BudgetWriter(
      (d, done) => {
        wrote += d.length
        done?.()
      },
      { budget: 4, schedule: s.schedule },
    )

    w.write(bytes(10), () => doneAt.push(wrote))
    s.tick()
    expect(doneAt, '才滴了 4 字节，窗口不能收').toEqual([])
    s.tick()
    expect(doneAt).toEqual([])
    s.tick()
    expect(doneAt, '最后一片写完才收窗口').toEqual([10])
  })

  it('UT-writer-3 writeNow：积压连同新数据一次写完，顺序不变（AC-5.9 的"一次写完"）', () => {
    const writes: string[] = []
    const s = manualScheduler()
    const w = new BudgetWriter((d) => writes.push(dec(d)), { budget: 4, schedule: s.schedule })

    w.write(enc('0123456789'))
    s.tick()
    expect(writes).toEqual(['0123'])
    w.writeNow(enc('TAIL'))
    expect(writes.join(''), '剩下的 + 新数据，全在这一次落地').toBe('0123456789TAIL')
    expect(w.pending).toBe(0)
    // 排空之后再来的小块照旧直接写
    w.write(enc('x'))
    expect(writes.join('')).toBe('0123456789TAILx')
  })

  it('clear 丢掉积压，但 done 照调 —— 丢了数据却不收窗口，之后用户敲的字会被一直吞掉', () => {
    const writes: string[] = []
    const s = manualScheduler()
    let closed = 0
    const w = new BudgetWriter((d) => writes.push(dec(d)), { budget: 4, schedule: s.schedule })

    w.write(enc('0123456789'), () => closed++)
    s.tick()
    expect(writes).toEqual(['0123'])
    w.clear()
    expect(w.pending).toBe(0)
    expect(closed, 'clear 也要收窗口').toBe(1)
    s.tick()
    expect(writes, '丢掉的不再写出去').toEqual(['0123'])
  })

  it('空块不写也不排队，但 done 要调（调用方等着收窗口）', () => {
    const writes: string[] = []
    let closed = 0
    const w = new BudgetWriter((d) => writes.push(dec(d)), { schedule: () => {} })
    w.write(new Uint8Array(0), () => closed++)
    expect(writes).toEqual([])
    expect(closed).toBe(1)
  })

  it('默认预算是 64 KiB', () => {
    expect(WRITE_BUDGET).toBe(64 * 1024)
  })
})
