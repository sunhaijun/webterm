/** UT-textinput-1：文本输入页的回车语义与切页手势（AC-3.19，input.md §文本输入页）。 */
import { describe, expect, it } from 'vitest'

import { PAGE_SWIPE_PX, isPageSwipe, textEnter } from '../src/keys/textpage'

const key = (isComposing = false, keyCode = 13) => ({ isComposing, keyCode })

describe('UT-textinput-1 回车（照 Termux）', () => {
  it('有内容：把内容发出去，不追加回车', () => {
    expect(textEnter('echo TEXT-ONE', key())).toEqual({ kind: 'input', data: 'echo TEXT-ONE' })
    expect(textEnter('你好', key())).toEqual({ kind: 'input', data: '你好' })
  })

  it('没有内容：发一个 \\r', () => {
    expect(textEnter('', key())).toEqual({ kind: 'input', data: '\r' })
  })

  it('正在组字：不处理，交给输入法选词（isComposing 或 keyCode 229）', () => {
    expect(textEnter('ni', key(true))).toEqual({ kind: 'none' })
    expect(textEnter('ni', key(false, 229))).toEqual({ kind: 'none' })
    expect(textEnter('', key(true)), '空框组字也不发 \\r').toEqual({ kind: 'none' })
  })

  it('含换行（只可能来自粘贴）：走 term.paste，括号粘贴由 xterm 按对端模式包', () => {
    expect(textEnter('echo L1\necho L2', key())).toEqual({ kind: 'paste', data: 'echo L1\necho L2' })
  })

  it('只有空白也算有内容（原样发出去）', () => {
    expect(textEnter('  ', key())).toEqual({ kind: 'input', data: '  ' })
  })
})

describe('键区上左右滑动切页', () => {
  it('横向位移 > 40px 且横向占优', () => {
    expect(PAGE_SWIPE_PX).toBe(40)
    expect(isPageSwipe(80, 0)).toBe(true)
    expect(isPageSwipe(-80, 10)).toBe(true)
    expect(isPageSwipe(40, 0), '恰好 40 不算').toBe(false)
    expect(isPageSwipe(50, 60), '纵向占优不算').toBe(false)
    expect(isPageSwipe(0, 0), '点一下不算').toBe(false)
  })
})
