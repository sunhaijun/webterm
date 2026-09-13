/**
 * UT-raw-1：Raw 模式下【直接插入的文本】（AC-3.14）。
 *
 * 软键盘不经过组字直接插字符 —— iOS 中文键盘的全角标点就走这条。
 * xterm 5.5 接不住它（keydown 发生过就忽略 input 事件，而 keyCode < 48 的键
 * 它自己又取不出字符），所以 RawIme 在 beforeinput 上自己接管。
 * 见 docs/40-frontend/input-modes.md §直接插入的文本。
 */
import { describe, expect, it, vi } from 'vitest'

import { RawIme } from '../src/input/raw'

function makeTextarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  return el
}

/** 软键盘直接插入一个字符时浏览器发的 beforeinput。 */
function beforeInput(data: string | null, inputType = 'insertText'): InputEvent {
  return new InputEvent('beforeinput', { inputType, data, cancelable: true, bubbles: true })
}

function composition(type: string, data: string): CompositionEvent {
  return new CompositionEvent(type, { data })
}

describe('UT-raw-1 Raw 模式：直接插入的文本', () => {
  it('非组字的 insertText 自己发出去，并 preventDefault（字符不落进 textarea）', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    const e = beforeInput('，')
    el.dispatchEvent(e)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('，')
    // 【关键】preventDefault：字符不进 textarea，xterm 的 input 路径与 229 差量路径
    // 就都不会再发一遍
    expect(e.defaultPrevented).toBe(true)
  })

  it('一次插入多个字符（预测输入整词上屏）原样发出', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(beforeInput('，。！'))
    expect(onCommit).toHaveBeenCalledWith('，。！')
  })

  it('组字期间不碰 —— 那是 compositionend 的活', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    const e = beforeInput('n')
    el.dispatchEvent(e)

    expect(onCommit).not.toHaveBeenCalled()
    expect(e.defaultPrevented, '组字中绝不能拦 —— 拦了输入法就废了').toBe(false)
  })

  it('inputType 不是 insertText 的不碰（组字文本 / 删除 / 替换各有各的路）', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    for (const t of ['insertCompositionText', 'deleteContentBackward', 'insertReplacementText', 'insertFromPaste']) {
      const e = beforeInput('x', t)
      el.dispatchEvent(e)
      expect(e.defaultPrevented, t).toBe(false)
    }
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('data 为空的 insertText 不发', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(beforeInput(null))
    el.dispatchEvent(beforeInput(''))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('compositionend 之后补发的同一段文字吃掉不重发（WebKit 会补这一发）', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'nihao'))
    el.dispatchEvent(composition('compositionend', '你好'))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('你好')

    const e = beforeInput('你好')
    el.dispatchEvent(e)
    expect(onCommit, '同一段文字不能发两遍').toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented, '吃掉它 —— 别让它落进 textarea').toBe(true)
  })

  it('compositionend 之后紧跟的【标点】照常发出 —— 组字完接着打逗号是常事', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionend', '你好'))
    el.dispatchEvent(beforeInput('，'))

    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenNthCalledWith(2, '，')
  })

  it('keypress 刚发过同一个字符就吃掉 —— xterm 的 _keyPress 已经送过了', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'é', bubbles: true }))
    const e = beforeInput('é')
    el.dispatchEvent(e)

    expect(onCommit, 'xterm 已经发过，不能再发一遍').not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('keypress 的是别的字符，不影响这一发', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }))
    el.dispatchEvent(beforeInput('，'))
    expect(onCommit).toHaveBeenCalledWith('，')
  })

  it('dispose 之后不再接管', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const ime = new RawIme(el, { onCommit, onPreview: vi.fn() })
    ime.dispose()

    const e = beforeInput('，')
    el.dispatchEvent(e)
    expect(onCommit).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
})
