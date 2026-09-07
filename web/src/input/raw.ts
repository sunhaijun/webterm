/**
 * Raw 模式的 IME 处理 —— docs/40-frontend/input-modes.md §Raw 实现要点。
 *
 * 按键直通 PTY，但组字期间【一个字节都不能发】：只在 compositionend 时
 * 把最终文本一次性发出去。组字过程中在光标位置渲染内联预览浮层，
 * 让用户知道自己在打什么。
 */

export interface RawImeHandlers {
  /** 提交最终文本（compositionend）。 */
  onCommit(text: string): void
  /** 组字内容变化，更新浮层。空串表示隐藏。 */
  onPreview(text: string): void
}

/**
 * RawIme 挂在 xterm 的隐藏 textarea 上。
 *
 * 那个 textarea 不能用 display:none —— 否则拿不到 composition 事件。
 */
export class RawIme {
  private composing = false
  private readonly el: HTMLTextAreaElement
  private readonly h: RawImeHandlers
  private readonly listeners: [string, EventListener][] = []

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
      if (data) this.h.onCommit(data)
      // 清掉 textarea，避免 xterm 自己再把同一段内容当成输入发一遍
      this.el.value = ''
    })
  }

  /** 组字中？keydown 处理器必须在它为 true 时【全部 return】（AC-3.3）。 */
  get isComposing(): boolean {
    return this.composing
  }

  dispose(): void {
    for (const [type, fn] of this.listeners) this.el.removeEventListener(type, fn)
    this.listeners.length = 0
  }

  private on(type: string, fn: (e: Event) => void): void {
    this.el.addEventListener(type, fn)
    this.listeners.push([type, fn])
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
