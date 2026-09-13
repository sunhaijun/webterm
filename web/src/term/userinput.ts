/**
 * 「此刻这一下 `onData` 是用户产生的吗」（[ADR-0020](../../../docs/20-architecture/adr/0020-input-never-silently-dropped.md) 决策二）。
 *
 * xterm 的 `onData` 上有两样东西：
 *
 *   · 它对历史查询（DSR / DA / `CSI ?u` …）的**自动应答** —— 同步发生在
 *     `term.write()` 的解析里；回放期间必须拦住，否则等于给前台程序喂乱码。
 *   · 用户的**按键 / 粘贴** —— 同步发生在一次 DOM 输入事件的派发里；永远要放行。
 *
 * 判据因此是「谁产生的」，不是「什么时候」。按"会话是否在回放"一刀切，就会把
 * 用户正在敲的字一起吞掉 —— 而回放窗口在 `ring_bytes` 满载时是秒级的。
 *
 * 实现只有一行：问浏览器**正在派发的是哪个事件**。`window.event` 是 DOM 标准里
 * 为兼容保留的那个全局，派发期间指向当前事件，派发一结束就恢复。
 *
 * **为什么不自己挂监听器开一个时间窗**：xterm 对它处理掉的按键会
 * `preventDefault + stopPropagation`（`cancel(event, true)`），冒泡阶段收不到，
 * 窗口只能靠定时器关 —— 而定时器任务与网络任务之间没有顺序保证，中间插进来的
 * 一次解析就会把自动应答放出去。`window.event` 没有这个缝。
 */

/** xterm 会在其中同步 `triggerDataEvent` 的那几个事件。 */
const USER_INPUT_EVENTS: ReadonlySet<string> = new Set([
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'compositionend',
  'compositionupdate',
])

/**
 * 正在派发的事件是不是用户输入事件。
 *
 * 两个容易漏的情形它都盖住了：
 *  - xterm 在用户刚输入过之后会**同步**解析下一次 `write()`（它自己的
 *    `_didUserInput` 优化），而那次 write 发起自 WebSocket 的 `message` 事件 ——
 *    `type` 不在表里，自动应答照样被拦住；
 *  - `setTimeout` 驱动的分片解析没有正在派发的事件，同样被拦住。
 *
 * 非浏览器环境里 `window.event` 不存在，判据恒为 false —— 行为退回"回放期间
 * 一律丢弃"的旧样子，不会更糟。
 */
export function inUserInputEvent(): boolean {
  const ev = (globalThis as { event?: Event | null }).event
  return !!ev && USER_INPUT_EVENTS.has(ev.type)
}
