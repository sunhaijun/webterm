/** UT-textinput-1：文本输入页的回车语义与切页手势（AC-3.19，input.md §文本输入页）。 */
import { describe, expect, it } from 'vitest'

import { PAGE_SWIPE_PX, isPageSwipe, textEnter } from '../src/keys/textpage'

const key = (isComposing = false, keyCode = 13) => ({ isComposing, keyCode })

describe('UT-textinput-1 回车 = 发送并提交（ADR-0027）', () => {
  it('有内容：发内容并回车', () => {
    expect(textEnter('echo TEXT-ONE', key())).toEqual({ kind: 'submit', text: 'echo TEXT-ONE' })
    expect(textEnter('你好', key())).toEqual({ kind: 'submit', text: '你好' })
  })

  it('多行（只可能来自粘贴）也一样：整块交出去，由调用方走 term.paste', () => {
    expect(textEnter('echo L1\necho L2', key())).toEqual({ kind: 'submit', text: 'echo L1\necho L2' })
  })

  it('没有内容：只回车', () => {
    expect(textEnter('', key())).toEqual({ kind: 'submit', text: '' })
  })

  it('正在组字：不处理，交给输入法选词（isComposing 或 keyCode 229）', () => {
    expect(textEnter('ni', key(true))).toEqual({ kind: 'none' })
    expect(textEnter('ni', key(false, 229))).toEqual({ kind: 'none' })
    expect(textEnter('', key(true)), '空框组字也不发 \\r').toEqual({ kind: 'none' })
  })

  it('只有空白也算有内容（原样发出去）', () => {
    expect(textEnter('  ', key())).toEqual({ kind: 'submit', text: '  ' })
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
