/**
 * 「此刻这一下 `onData` 是用户产生的吗」（ADR-0020 决策二，input.md §回放门只吞自动应答）。
 *
 * xterm 的 `onData` 上有两样东西：
 *
 *   · 它对历史查询（DSR / DA / `CSI ?u` …）的**自动应答** —— 同步发生在
 *     `term.write()` 的解析里；回放期间必须拦住，否则等于给前台程序喂乱码。
 *   · 用户的**按键 / 粘贴 / 附加键 / 文本页** —— 同步发生在一次 DOM 输入事件的派发里；永远要放行。
 *
 * 判据因此是「谁产生的」，不是「什么时候」。实现只有一行：问浏览器**正在派发的是
 * 哪个事件** —— `window.event` 在派发期间指向当前事件，派发一结束就恢复。
 *
 * **为什么不自己开时间窗**：xterm 对它处理掉的按键 `preventDefault + stopPropagation`，
 * 冒泡阶段收不到，窗口只能靠定时器关 —— 而定时器任务与网络任务之间没有顺序保证。
 */

/**
 * 用户输入事件表。`pointerdown` / `pointerup` 是附加键：它在一次指针事件的派发里同步调
 * `term.input()`。`mousedown` / `mouseup` / `mousemove` / `wheel` 是程序开了鼠标跟踪时
 * xterm 同步发出的鼠标上报（以及备用屏里滚轮转成的方向键）—— 那也是用户在操作。
 * 新增一种能产生 onData 的用户交互时，想让它在回放期间也放行，就把它的事件类型加进来；
 * 不加也只是回到"回放期间丢弃"，不会更糟。
 */
export const USER_INPUT_EVENTS: ReadonlySet<string> = new Set([
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'compositionend',
  'compositionupdate',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'mousemove',
  'wheel',
])

/**
 * 正在派发的事件是不是用户输入事件。
 *
 * 两个容易漏的情形它都盖住了：xterm 在用户刚输入过之后会**同步**解析下一次
 * `write()`，而那次 write 发起自 WebSocket 的 `message` 事件 —— 不在表里，照样拦住；
 * `setTimeout` 驱动的分片解析没有正在派发的事件，同样拦住。
 */
export function inUserInputEvent(): boolean {
  const ev = (globalThis as { event?: Event | null }).event
  return !!ev && USER_INPUT_EVENTS.has(ev.type)
}
