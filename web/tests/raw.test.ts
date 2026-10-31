/**
 * UT-raw-1：终端直输时【直接插入的文本】（AC-3.14）。
 *
 * 软键盘不经过组字直接插字符 —— iOS 中文键盘的全角标点就走这条。
 * xterm 5.5 接不住它（keydown 发生过就忽略 input 事件，而 keyCode < 48 的键
 * 它自己又取不出字符），所以 RawIme 在 beforeinput 上自己接管。
 * 见 docs/40-frontend/input.md §直接插入的文本。
 */
import { describe, expect, it, vi } from 'vitest'

import { RawIme } from '../src/keys/raw'

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

describe('UT-raw-1 终端直输：直接插入的文本', () => {
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

  it('连打两下同一个字符：两下都要进 —— 去重不能吃掉用户的第二下（AC-3.14 / ADR-0020）', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    // 软键盘直接插入的字符【只走 beforeinput 这一条路】（keyCode 0，xterm 两头都不接），
    // 所以第二下没有别的路会替它发 —— 这里吃掉就是永久丢字
    el.dispatchEvent(beforeInput('，'))
    el.dispatchEvent(beforeInput('，'))

    expect(onCommit, '用户打了两下就该发两下').toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenNthCalledWith(1, '，')
    expect(onCommit).toHaveBeenNthCalledWith(2, '，')
  })

  it('去重是【一次性】的：压掉补发的那一次之后就撤防，再来的同一段是新输入', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionend', '哈'))
    expect(onCommit).toHaveBeenCalledTimes(1)

    el.dispatchEvent(beforeInput('哈')) // WebKit 的补发 —— 吃掉
    expect(onCommit).toHaveBeenCalledTimes(1)

    el.dispatchEvent(beforeInput('哈')) // 用户自己又打了一个「哈」—— 必须发
    expect(onCommit, '撤防之后就是新输入').toHaveBeenCalledTimes(2)
  })

  it('keypress 的去重同样一次性：连按两下，xterm 发两下、我们一下都不补', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    // 物理键盘：每一下都有自己的 keypress（xterm 已经送出去了），各自布防各自压掉
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'l', bubbles: true }))
      el.dispatchEvent(beforeInput('l'))
    }
    expect(onCommit, 'xterm 送的，我们一下都不该补').not.toHaveBeenCalled()
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

/**
 * UT-raw-2：组字状态的兜底复位（AC-3.3 / ADR-0020）。
 *
 * `composing` 原本只有 compositionend 一个出口，而它不保证来 —— 切输入法、
 * 切窗口、候选框被系统吞掉都可能让组字停在半路。卡在 true 的后果是
 * 【这个会话的终端输入永久失效】（keydown 处理器全部 return），用户没有任何
 * 线索，只能刷新页面。
 */
describe('UT-raw-2 组字兜底复位', () => {
  const start = (el: HTMLTextAreaElement) => {
    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'ni'))
  }

  it('blur：元素都不是焦点了，组字不可能还在进行', () => {
    const el = makeTextarea()
    const onPreview = vi.fn()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview })

    start(el)
    expect(ime.isComposing).toBe(true)

    el.dispatchEvent(new FocusEvent('blur'))

    expect(ime.isComposing, 'blur 之后必须放行输入').toBe(false)
    expect(onPreview).toHaveBeenLastCalledWith('') // 浮层也要收掉
  })

  it('一个 isComposing=false 的 keydown 就证明组字已经结束', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, isComposing: false }))

    expect(ime.isComposing).toBe(false)
  })

  it('组字中的按键不误复位：isComposing=true 或 keyCode 229 都还在组字', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', keyCode: 78, isComposing: true }))
    expect(ime.isComposing, 'isComposing=true 的键就是在组字').toBe(true)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229 }))
    expect(ime.isComposing, '229 是输入法占用的按键').toBe(true)
  })

  it('复位【必须发生在 xterm 之前】—— 所以挂在捕获阶段', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })
    // xterm 的监听器挂在冒泡阶段（RawIme 是 term.open() 之后才构造的，排在它后面）
    let composingSeenByXterm: boolean | null = null
    el.addEventListener('keydown', () => (composingSeenByXterm = ime.isComposing))

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, isComposing: false }))

    expect(composingSeenByXterm, '轮到 xterm 时组字必须已经复位，否则这一下按键还是丢').toBe(false)
  })

  it('兜底复位之后 compositionend 仍然来了：照常提交，不丢字', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const ime = new RawIme(el, { onCommit, onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new FocusEvent('blur'))
    el.dispatchEvent(composition('compositionend', '你好'))

    expect(onCommit).toHaveBeenCalledWith('你好')
    expect(ime.isComposing).toBe(false)
  })

  it('dispose 之后不再有任何监听', () => {
    const el = makeTextarea()
    const onPreview = vi.fn()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview })
    ime.dispose()

    start(el)
    el.dispatchEvent(new FocusEvent('blur'))

    expect(onPreview).not.toHaveBeenCalled()
    expect(ime.isComposing).toBe(false)
  })
})
