# ADR-0040 Sessions can be reordered by dragging; the order lives on the agent

Status: Accepted (2026-10-31). The protocol gains `session.move` / `session.order` ([websocket-protocol.md](../../30-protocol/websocket-protocol.md) §4) without a version bump (§8: new message types may be added freely).

## Context

The user wanted to reorder sessions by dragging.

The order was fixed: the client sorted by `created_at`, the agent by `sid`. The drawer's `[n]` meant "nth in creation order", and `Ctrl+Shift+↑/↓` followed that order too.

## Decision

### 1. Order is agent state, like the session name

The order is a list of `sid`s kept in the agent's session manager:

- New sessions go last; closed sessions are removed.
- `welcome.sessions[]` is sent in this order, and clients display it as is.
- A client sends `session.move{sid, before}` to move a session in front of `before` (`before: null` moves it to the end). The agent applies it and broadcasts the whole list to every connection as `session.order{sids}`.
- **Hot upgrade carries the order**: `sessions[]` in the handoff snapshot is in display order, and the new process restores that order. The snapshot format is unchanged (schema still 2); an old snapshot (sorted by `sid`) restores in `sid` order.
- When the agent restarts, the order is gone along with the sessions.

**Why not keep it in the browser**: session names are already agent state, identical on every device. If order lived only in one browser, `[n]` on the phone and the computer wouldn't match. sids are also reused after an agent restart, so `localStorage` would have to tie the order to `instance_id` to avoid mixing them up.

### 2. The client moves first, then follows the broadcast

On release the client shows the new order immediately and sends `session.move`. When `session.order` arrives, it wins. If two devices drag at once, whichever reaches the agent last takes effect, and both converge.

`session.order` may arrive before a session's `session.created`: another connection just created a session and someone dragged right after. So the client **keeps a slot** for sids in `sids` it doesn't know yet; when that session's `session.created` arrives, it lands where the agent put it rather than at the end.

`[n]` now means "nth in the current order", and `Ctrl+Shift+↑/↓` and "switch to the neighbor after closing the current session" follow the current order.

### 3. How dragging works

| Where | How it starts | Axis |
|---|---|---|
| `wide` tab bar, mouse | Press a tab and move more than 5px horizontally | Horizontal |
| `wide` tab bar, touch (tablet) | Long-press a tab (500ms), then move without lifting; releasing in place after a long-press still opens the session menu | Horizontal |
| `compact` drawer | Drag the grip at the right end of a row (`≡`, 44px wide); the rest of the row behaves as before (tap, swipe left, long-press, vertical scroll) | Vertical |

- While dragging, the dragged item follows the pointer (`translate`) and is lifted with a shadow; the others move aside. On release it's inserted where the pointer is; if the position didn't change, nothing is sent.
- The `click` that follows a drag is swallowed, so it doesn't switch sessions.
- When the tab strip or the drawer list is long enough to scroll, dragging within 32px of an edge auto-scrolls that way.
- `Esc` cancels a drag in progress and puts the item back.
- The grip is a line icon (three horizontal lines, [layout.md, Icons](../../40-frontend/layout.md#icons)), `data-testid="session-<sid>-grip"`. On phones the grip is the visible entry point; on tablets long-press-drag is a shortcut and the menu still works.

Why a grip on phones rather than long-press-drag: long-pressing a row already reveals its buttons ([ADR-0039](0039-drawer-row-swipe-actions.md)), swiping left is taken too, and vertical drag scrolls the list. A visible grip competes with no gesture.

### Rejected alternatives

- **Keep the order only in the browser.** See §1.
- **Have `session.move` carry a target index instead of `before`.** With two devices acting at once, an index may already point somewhere else; "put it before that session" is unaffected by other sessions being inserted or removed.
- **Long-press then drag in the drawer.** Long-press is already taken by row actions; see §3.
- **Reorder with the keyboard** (e.g. `Ctrl+Shift+PgUp/PgDn`). Browsers use those combinations to switch tabs, and nobody asked for it.

## Consequences

- The protocol gains two messages; the agent's session manager gets an order list that `List()` follows, and the handoff snapshot's `sessions[]` is sorted by it.
- The client's session order comes from the agent's list instead of sorting by `created_at`.
- Adds AC-4.13, E2E-45, UT-order-1, IT-order-1.
