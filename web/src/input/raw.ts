/**
 * Raw 模式的文本输入 —— docs/40-frontend/input-modes.md §Raw 实现要点。
 *
 * 两条路：
 *  1. 【组字】期间一个字节都不能发，只在 compositionend 时把最终文本一次性发出去；
 *     过程中在光标位置渲染内联预览浮层，让用户知道自己在打什么。
 *  2. 【直接插入】的字符（软键盘不经过组字就插进来的，iOS 中文键盘的全角标点就是）
 *     由这里自己接管 —— xterm 接不住，见下面 beforeinput 处的注释（AC-3.14）。
 */

export interface RawImeHandlers {
  /** 提交最终文本（compositionend，或非组字的直接插入）。 */
  onCommit(text: string): void
  /** 组字内容变化，更新浮层。空串表示隐藏。 */
  onPreview(text: string): void
}

/**
 * 去重窗口：compositionend 之后这么久之内、同一段文字的 insertText 算重复。
 * WebKit 会在组字提交后再补发一次 insertText，那是同一段文字，不能发两遍。
 */
const DEDUP_MS = 120

/**
 * RawIme 挂在 xterm 的隐藏 textarea 上。
 *
 * 那个 textarea 不能用 display:none —— 否则拿不到 composition 事件。
 */
export class RawIme {
  private composing = false
  /** 最近一次已经发出去的文本 + 时刻，用来吃掉浏览器补发的同一段文字。 */
  private sent = ''
  private sentAt = 0
  private readonly el: HTMLTextAreaElement
  private readonly h: RawImeHandlers
  private readonly listeners: [string, EventListener, boolean][] = []

  constructor(el: HTMLTextAreaElement, h: RawImeHandlers) {
    this.el = el
    this.h = h

    this.on('compositionstart', () => {
      this.composing = true
      this.h.onPreview('')
    })
    this.on('compositionupdate', (e) => {
      // 【不发送任何字节】，只更新浮层
      this.h.onPreview((e as CompositionEvent).data ?? '')
    })
    this.on('compositionend', (e) => {
      this.composing = false
      this.h.onPreview('')
      const data = (e as CompositionEvent).data ?? ''
      if (data) this.commit(data)
      // 清掉 textarea，避免 xterm 自己再把同一段内容当成输入发一遍
      this.el.value = ''
    })

    // 【兜底复位】（AC-3.3 / ADR-0020）。上面那三条里 composing 只有一个出口 ——
    // compositionend。可它不保证来：切输入法、切窗口、候选框被系统吞掉，都可能让
    // 组字停在半路。而 composing 卡在 true 的后果是【这个会话的终端输入永久失效】
    // （keydown 处理器全部 return），用户没有任何线索，只能刷新页面。
    //
    // blur：元素都不是焦点了，组字不可能还在进行。
    this.on('blur', () => this.stopComposing())
    // keydown：浏览器自己说了这不是组字中的按键（isComposing=false 且不是输入法
    // 占用的 229）。【必须挂在捕获阶段】—— RawIme 是 term.open() 之后才构造的，
    // 冒泡阶段排在 xterm 的 keydown 后面，等它跑完这一下按键已经被当成"组字中"
    // 丢掉了。复位要发生在 xterm 处理这个键【之前】。
    this.on(
      'keydown',
      (e) => {
        const ke = e as KeyboardEvent
        if (ke.isComposing || ke.keyCode === 229) return
        this.stopComposing()
      },
      true,
    )

    // xterm 的 _keyPress 在它自己处理掉一个可打印字符时【不会】preventDefault
    //（cancelEvents 默认 false），那个字符还是会插进 textarea、再发一次 beforeinput。
    // 记下来，下面去重用
    this.on('keypress', (e) => {
      const key = (e as KeyboardEvent).key
      if (key && key.length === 1) this.mark(key)
    })

    // 【直接插入的文本由我们自己发】（AC-3.14）。
    //
    // xterm 5.5 的三条路都接不住 iOS 软键盘的全角标点：
    //  · keydown 直接取字，条件是 keyCode >= 48 —— iOS 对这类直接插入报 keyCode 0；
    //  · input 事件兜底，条件是没见过 keydown（_keyDownSeen）—— 可 keydown 刚发生过；
    //  · keyCode === 229 的 textarea 差量，只在恰好是 229 时走。
    // 于是同一个键盘上，报 229 的键（句号）能进，报 0 的键（逗号）两头都不接、字就没了。
    //
    // 这里在 beforeinput 上接管：preventDefault 让字符【不落进 textarea】，
    // xterm 的 input 路径与 229 差量路径就都不会再发一遍。
    // 组字不碰（那是 compositionend 的活）；xterm 在 keydown 里处理掉的键会
    // preventDefault，根本不会有 beforeinput，普通按键完全不受影响。
    this.on('beforeinput', (e) => {
      const ie = e as InputEvent
      if (this.composing || ie.isComposing) return
      if (ie.inputType !== 'insertText') return
      const data = ie.data
      if (!data) return
      // 不管发不发，都别让它落进 textarea —— 落进去 xterm 的差量路径会补一刀
      e.preventDefault()
      if (data === this.sent && Date.now() - this.sentAt < DEDUP_MS) return
      this.commit(data)
    })
  }

  /** 组字结束（正常的 compositionend 走的是自己那条路，这里是兜底）。 */
  private stopComposing(): void {
    if (!this.composing) return
    this.composing = false
    this.h.onPreview('') // 浮层也要收掉，否则留一片没人管的预览挂在屏幕上
  }

  /** 发出去，并记下来用于去重。 */
  private commit(text: string): void {
    this.mark(text)
    this.h.onCommit(text)
  }

  private mark(text: string): void {
    this.sent = text
    this.sentAt = Date.now()
  }

  /** 组字中？keydown 处理器必须在它为 true 时【全部 return】（AC-3.3）。 */
  get isComposing(): boolean {
    return this.composing
  }

  dispose(): void {
    for (const [type, fn, capture] of this.listeners) this.el.removeEventListener(type, fn, capture)
    this.listeners.length = 0
  }

  private on(type: string, fn: (e: Event) => void, capture = false): void {
    this.el.addEventListener(type, fn, capture)
    this.listeners.push([type, fn, capture])
  }
}

/** 内联预览浮层应当摆在哪 —— 跟着终端光标走。 */
export interface CursorRect {
  left: number
  top: number
}

export function cursorPosition(
  cursorX: number,
  cursorY: number,
  cell: { width: number; height: number },
): CursorRect {
  return { left: cursorX * cell.width, top: (cursorY + 1) * cell.height }
}
