# ADR-0020 Input is never silently dropped

Status: Accepted (2026-09-13).

## Context

The user reported "typing in the terminal often gets stuck". It wasn't one bug but **independent paths with identical symptoms**: the keys never reach the PTY, nothing changes on screen, and nothing says why.

| # | Mechanism | Symptom | Recovery |
|---|---|---|---|
| 1 | Zombie WebSocket: the link is dead but there's no `onclose`; `readyState` is still OPEN | Status says online, typing has no echo | The heartbeat declares it dead after 40 s and it heals |
| 2 | The replay gate blocks `onData` per session | All typing lost for a few seconds after switching back to a session or reconnecting | Heals once replay finishes parsing |
| 3 | Focus falls back to `body` on a session switch | Typing does nothing at all | Tap the terminal |
| 4 | `compositionend` never arrives, so `composing` stays true forever | Typing does nothing at all in that session | Switch away and back, or reload |
| 5 | **`client_id` survives a reload while `in_seq` restarts at 0**, so the agent drops new input as already-processed resends (fixed with [ADR-0026](0026-agent-holds-terminal-state.md)) | Typing does nothing after a reload | **None**: tapping the terminal, switching sessions and reconnecting don't help, and reloading again makes it worse |

1 and 2 stack: after finally reconnecting at 40 s, the replay window follows and typing still doesn't get through. That was the main source of "often stuck".

Row 5 was added later and differs from the others: the first four heal or have a recovery action; it has neither. The agent's `accepted` count only grows, so each reload owes more ("I can never type"). It survived several rounds of debugging because the browser, the protocol and the agent all stayed silent. The fix scopes `client_id` to one page load ([protocol §4.1, §5.4](../../30-protocol/websocket-protocol.md#54-input-resend-queue)), and the agent leaves a trace when it sees this shape.

## Decision

**Principle: a keystroke has exactly two outcomes. It reaches the PTY, or it fails visibly.**

"Fails visibly" means the status changes to "reconnecting", or an explicit message appears. **Silent drops are not allowed**: to the user they're indistinguishable from a hang, and the next thing the user does is type it again, so after the reconnect both copies run.

The other half of the same principle: **no silent deactivation**. Once the connection, focus or composition state gets stuck on the wrong side, the user has no clue that they need to tap the terminal or reload.

This principle yields two decisions.

### Decision 1: external events trigger an immediate liveness probe

**Before**: the client sent a `ping` every 30 s and declared the connection dead after 10 s without a `pong` (protocol §5.5). `online` / `visibilitychange` called `retryNow()`, which returned immediately when `state === 'online'`.

The problem is that **a zombie connection believes it's online**. Screen off, app switch, Wi-Fi to cellular, a NAT or proxy silently reaping the connection: in all of these the TCP connection gets no FIN, the browser fires no `onclose`, and `readyState` stays OPEN. The heartbeat is then the only detector: worst case 30 + 10 = 40 s, and longer in background tabs, where `setInterval` is throttled.

**Now**: the `online` event and "page visible again" are no longer just reconnect accelerators that matter only while reconnecting. They **trigger a liveness probe**:

```
retryNow():
  stopped              → do nothing
  believes it's online → send a ping now; no pong within 2 s → close the connection → reconnect
  otherwise            → reset backoff, reconnect now (as before)
```

2 s instead of the heartbeat's 10 s: the probe happens at a **known suspicious moment** (just back from the background, or the OS just reported a network change), when the connection is either alive (local RTT is far below 2 s) or dead. A wrong call costs one reconnect, and reconnects are lossless (resume + `in_ack` resend).

**Rejected**: shortening the 30 s heartbeat. That spends battery and data all the time to get an answer needed only at specific moments. On phones the heartbeat is the last overhead to make more frequent, and "just came back to the foreground" is a free and precise moment.

### Decision 2: the replay gate asks who produced the data, not when

**Before**: during replay, all `onData` was blocked. The reason is right: replayed history contains terminal queries the program sent (DSR / DA / `CSI ?u`), and xterm **answers them automatically**. Those answers aren't user input; sending them to the PTY feeds garbage to the foreground program (protocol §5.3 / AC-2.15).

The problem is that the gate used the wrong dimension. `onData` carries two kinds of data:

| Source | When it happens |
|---|---|
| xterm's automatic answers to historical queries | Synchronously, inside `term.write()` parsing |
| User keystrokes / paste | Synchronously, inside the dispatch of a DOM input event |

Gating on "is this session replaying right now" approximates the source by time, and **swallows the user's keystrokes along with it**. And the replay window isn't instant: switching back to a session that produced a lot of output means a full reset replay of the ring buffer, which xterm parses in 12 ms slices to yield the main thread. On a phone that takes **seconds**.

**Now**: ask the browser directly which event is being dispatched right now: `window.event`, the global kept in the DOM standard for compatibility (Chrome, Safari and Firefox all have it). It points at the current event during dispatch and resets afterwards, which is exactly the test we need:

```
onData(data):
  window.event?.type ∈ {keydown, keypress, beforeinput, input, paste, compositionend, compositionupdate}
                          → pass (even during replay)
  else if replayDepth > 0 → drop (automatic answer, as before)
  else                    → pass
```

It covers the easy-to-miss cases exactly:

- Right after user input, xterm's `WriteBuffer` parses the next `write()` **synchronously** (its `_didUserInput` optimization). That `write()` was started from the WebSocket `message` event, so `window.event.type === 'message'`, which isn't in the list, and the automatic answer is still blocked.
- Slice parsing driven by `setTimeout` has no event being dispatched; `window.event` is `undefined`, so it's blocked too.

**Not a time window opened by our own listener**: xterm calls `preventDefault + stopPropagation` (`cancel(event, true)`) on keys it handles, so a bubbling listener never sees them, and the window could only be closed by a timer. There's no ordering guarantee between timer tasks and network tasks, so a parse slipping in between would let an automatic answer through. `window.event` has no such gap.

If `window.event` doesn't exist (a non-browser environment), the test is always false and behavior **reverts to the old gate**, never worse.

**Why not remove the replay gate**: the automatic answers are real, and E2E-30 catches them.

**Why not filter by content** ("drop anything that looks like a DSR reply"): users can type exactly the same bytes, and the filter would have to track the set of terminal queries forever, always missing some.

### Corollaries

These aren't new decisions; they follow directly from the principle.

- **Focus follows the session.** When `activate()` detaches the previous session's DOM, focus falls back to `body`, and nobody gives it to the new session. Rule: if focus was in the terminal before the switch, give it back to the terminal after; on desktop (non-touch), always give it back, since there's no on-screen keyboard to worry about. See [`../../40-frontend/session-ux.md`](../../40-frontend/session-ux.md).
- **Composition state needs a fallback reset.** `composing` was only reset by `compositionend`, which may never arrive when switching IMEs or windows. Two fallbacks: `blur`, and a capture-phase `keydown` with `isComposing === false` (which itself proves composition has ended). See [`../../40-frontend/input.md`](../../40-frontend/input.md).
- **The principle must be observable.** The rules above constrain the implementation but don't answer "**how do we confirm it isn't being violated?**" After the four paths were fixed, the next "typing does nothing" would still start with guessing. So the input path keeps a counter per stage: key reaches the page → focus is in the terminal → xterm emits `onData` → sent to the agent → acknowledged by the agent. Each stage has a count and the **time of its last occurrence**, so the break point is visible at a glance (`__webterm.inputStats()`, AC-3.17, see [`../../40-frontend/input.md`](../../40-frontend/input.md)). It also covers problems **outside webterm**: if all stages pass and the program doesn't react, the problem is on the PTY side, most often tmux copy-mode ([ADR-0024](0024-scrollback-layered-model.md) §4).

## Consequences

- Zombie connections are exposed in ~2 s instead of up to 40 s, and at the moment the user is most likely about to type (just unlocked the phone).
- Typing during replay is no longer lost; automatic answers are still blocked.
- One more concept to maintain, the list of "user input events". If a new user interaction produces `onData` (mouse tracking, for example) and should pass during replay, add its event type to the list. **Forgetting doesn't regress anything**; it just behaves as before.
- `ping`'s protocol semantics are unchanged. The probe reuses the same message, and the agent needs no changes.
