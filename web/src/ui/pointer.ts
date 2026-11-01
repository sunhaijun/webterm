/** 拿指针捕获：之后的 move / up 都归这个元素。合成事件没有活动指针时会抛，拿不到也无妨。 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    /* 合成事件没有活动指针 */
  }
}
