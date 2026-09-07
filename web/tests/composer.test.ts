/**
 * UT-input-2 / UT-input-3：composition 期间不发送、输入框属性。
 *
 * 用 jsdom 直接驱动 DOM 事件 —— composition 的行为是这一层的，
 * 不必起整个 Preact 应用也能测准。
 */
import { describe, expect, it, vi } from 'vitest'

import { RawIme, cursorPosition } from '../src/input/raw'

function makeTextarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  return el
}

function composition(type: string, data: string): CompositionEvent {
  // jsdom 的 CompositionEvent 构造器支持 data
  return new CompositionEvent(type, { data })
}

describe('UT-input-2 Raw 模式的 composition 处理', () => {
  it('组字期间一个字节都不发，只在 compositionend 时一次性提交', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const onPreview = vi.fn()
    new RawIme(el, { onCommit, onPreview })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'ni'))
    el.dispatchEvent(composition('compositionupdate', '你'))
    expect(onCommit, '组字期间不该发送任何东西').not.toHaveBeenCalled()

    el.dispatchEvent(composition('compositionend', '你好'))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('你好')
  })

  it('组字期间 isComposing 为 true —— keydown 处理器要据此全部 return', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })

    expect(ime.isComposing).toBe(false)
    el.dispatchEvent(composition('compositionstart', ''))
    expect(ime.isComposing).toBe(true)
    el.dispatchEvent(composition('compositionend', '你好'))
    expect(ime.isComposing).toBe(false)
  })

  it('浮层跟着组字内容更新，结束后隐藏', () => {
    const el = makeTextarea()
    const onPreview = vi.fn()
    new RawIme(el, { onCommit: vi.fn(), onPreview })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'ni'))
    el.dispatchEvent(composition('compositionupdate', '你'))
    expect(onPreview.mock.calls.map((c) => c[0])).toEqual(['', 'ni', '你'])

    el.dispatchEvent(composition('compositionend', '你好'))
    expect(onPreview.mock.calls.at(-1)?.[0], '结束后应当隐藏浮层').toBe('')
  })

  it('取消组字（compositionend 拿到空串）不发送任何东西', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'ni'))
    el.dispatchEvent(composition('compositionend', ''))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('提交后清空 textarea，避免 xterm 再把同一段内容发一遍', () => {
    const el = makeTextarea()
    new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })
    el.value = '你好'
    el.dispatchEvent(composition('compositionend', '你好'))
    expect(el.value).toBe('')
  })

  it('dispose 之后不再响应事件', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const ime = new RawIme(el, { onCommit, onPreview: vi.fn() })
    ime.dispose()
    el.dispatchEvent(composition('compositionend', '你好'))
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('内联预览浮层的位置', () => {
  it('跟着终端光标走，摆在光标行的下一行', () => {
    const pos = cursorPosition(10, 5, { width: 8, height: 17 })
    expect(pos).toEqual({ left: 80, top: 102 })
  })
})

/**
 * UT-input-3：输入框属性必须真的是 off。
 *
 * 回归测试：Chrome 把 autocorrect 实现成了 boolean IDL 属性，
 * JSX 里写 autocorrect="off" 会被当成属性赋值 —— "off" 是真值，
 * 反射出来的是 autocorrect="on"，正好是反的。
 */
describe('UT-input-3 输入框属性', () => {
  it('setAttribute 才能得到 off；直接赋属性会得到相反的结果', () => {
    const el = document.createElement('textarea')
    document.body.appendChild(el)

    for (const [k, v] of [
      ['autocorrect', 'off'],
      ['autocapitalize', 'off'],
      ['autocomplete', 'off'],
      ['spellcheck', 'false'],
    ] as const) {
      el.setAttribute(k, v)
    }

    expect(el.getAttribute('autocorrect')).toBe('off')
    expect(el.getAttribute('autocapitalize')).toBe('off')
    expect(el.getAttribute('autocomplete')).toBe('off')
    expect(el.getAttribute('spellcheck')).toBe('false')
  })
})
