/**
 * 设备形态（AC-5.18，ADR-0025 §1，layout.md §形态）。
 *
 * **判据是屏幕短边，不是视口**：屏幕尺寸不随软键盘、旋转、地址栏、分屏变化，
 * 形态在一台设备上永远不翻转，也就不会因为形态切换去重排终端、给 PTY 发 SIGWINCH。
 */

export type Form = 'compact' | 'wide'

/** 手机短边最大约 440px，平板最小约 600px（iPad mini 744px），600 落在空档里。 */
export const COMPACT_BELOW = 600

export function formOf(screenWidth: number, screenHeight: number): Form {
  return Math.min(screenWidth, screenHeight) < COMPACT_BELOW ? 'compact' : 'wide'
}

/** 当前屏幕的形态。页面加载时调一次，之后不重算（见 controller.ts mount）。 */
export function readForm(): Form {
  return formOf(screen.width, screen.height)
}

/** 附加键：`compact` 恒显示，`wide` 只在触屏（`pointer: coarse`）时显示。 */
export function showsExtraKeys(form: Form, coarse: boolean): boolean {
  return form === 'compact' || coarse
}
