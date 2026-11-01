/**
 * 关闭确认（AC-4.11，ADR-0038）：不用浏览器的 `confirm()`。形态同设置：
 * `compact` 贴底 sheet、`wide` 居中浮窗；能叠在会话抽屉上面。
 *
 * 打开时焦点在「关闭」上：`Enter` 确认、`Esc` 取消，和以前的 `confirm()` 一样。
 */
import { useLayoutEffect, useRef } from 'preact/hooks'

import { Drawer } from '../ui/drawer'

export interface CloseConfirmProps {
  name: string
  onOk(): void
  onCancel(): void
}

export function CloseConfirm(p: CloseConfirmProps) {
  const okRef = useRef<HTMLButtonElement>(null)
  // Drawer 自己的 layout effect 先跑（子先于父），已经把焦点收进浮层；这里再落到「关闭」上
  useLayoutEffect(() => okRef.current?.focus({ preventScroll: true }), [])
  return (
    <Drawer
      title={`关闭「${p.name}」？`}
      testid="close-confirm"
      backdropTestid="close-confirm-backdrop"
      variant="confirm"
      onClose={p.onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="close-cancel" onClick={p.onCancel}>
            取消
          </button>
          <button type="button" class="drawer-btn danger" data-testid="close-ok" ref={okRef} onClick={p.onOk}>
            关闭
          </button>
        </div>
      }
    >
      <p class="confirm-text">会话里的程序会被结束。</p>
    </Drawer>
  )
}
