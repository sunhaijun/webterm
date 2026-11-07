/**
 * "Did the user produce this `onData` call?" (ADR-0020 decision 2, input.md: the replay
 * gate only swallows automatic replies).
 *
 * xterm's `onData` carries two kinds of data:
 *
 *   · automatic replies to old queries (DSR / DA / `CSI ?u` …), produced synchronously
 *     while `term.write()` parses. They must be blocked during replay, or the foreground
 *     program gets fed garbage.
 *   · user keystrokes, pastes, extra keys and text page input, produced synchronously
 *     while a DOM input event is dispatched. Always let these through.
 *
 * So the test is who produced it, not when. The implementation is one line: ask the
 * browser which event is being dispatched. `window.event` points at the current event
 * during dispatch and resets afterwards.
 *
 * Why not a time window: xterm calls `preventDefault + stopPropagation` on keys it handles,
 * so we never see them bubble and would have to close the window with a timer, and timer
 * tasks have no ordering guarantee relative to network tasks.
 */

/**
 * User input event types. `pointerdown` / `pointerup` are the extra keys, which call
 * `term.input()` synchronously inside a pointer event. `mousedown` / `mouseup` /
 * `mousemove` / `wheel` are the mouse reports xterm emits synchronously when a program
 * enables mouse tracking (and wheel-to-arrow-keys on the alternate screen); those are user
 * actions too. To let a new kind of user interaction that produces onData through during
 * replay, add its event type here; leaving it out just means it is dropped during replay,
 * which is no worse than before.
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

/** How many asUserInput() calls are running (they can nest). */
let explicitDepth = 0

/**
 * Runs `fn` as user input: onData it produces passes the replay gate. For user actions
 * that complete outside any event dispatch, so `window.event` can't vouch for them. Today
 * that is only pasting an uploaded file's path, which happens when the upload finishes,
 * seconds after the tap (ADR-0051 §3); without this, an upload finishing during a
 * reconnect's catch-up would lose its path silently.
 */
export function asUserInput<T>(fn: () => T): T {
  explicitDepth++
  try {
    return fn()
  } finally {
    explicitDepth--
  }
}

/**
 * Whether the event being dispatched is a user input event, or the code running was
 * marked as user input with asUserInput().
 *
 * Covers two easy-to-miss cases: right after user input, xterm may parse the next
 * `write()` synchronously, but that write comes from a WebSocket `message` event, which is
 * not in the set, so it is still blocked; and chunked parsing driven by `setTimeout` has
 * no event being dispatched, so it is blocked too.
 */
export function inUserInputEvent(): boolean {
  if (explicitDepth > 0) return true
  const ev = (globalThis as { event?: Event | null }).event
  return !!ev && USER_INPUT_EVENTS.has(ev.type)
}
