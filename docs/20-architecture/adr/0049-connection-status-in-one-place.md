# ADR-0049 Connection status in one place

Status: Accepted (2026-11-05). Amends the connection-status rules in [session-ux.md](../../40-frontend/session-ux.md#connection-status-ac-210) (AC-2.10).

## Context

Connection-related messages appeared in three places:

- **Top banner.** "Connecting…" and "Reconnecting" appeared in a full-width banner at the top edge of the terminal.
- **Toast.** "Resumed · caught up N KB", "Session ended" and "Not connected; can't …" appeared in a toast pill 32px below the top, whether or not the banner was there.
- **Gate page.** At startup, the auth check showed "Checking pairing…" as body text at the top left of an empty page, and "Can't reach the agent" as a full status page. The banner took over once the app mounted.

Every page load moved the message from one place to another.

## Decision

1. **Connection messages appear only in the top banner**, in the same slot at the top edge of the terminal:
   - **State.** "Connecting…" and "Reconnecting · retry in Ns" (warning color) show while not online.
   - **Note.** A short note appears next to the state, or alone once online, for 3 seconds:
     - "Resumed · caught up N KB" in the ok color;
     - "Session ended (agent may have restarted)" in the warning color;
     - an action refused while offline, such as "Can't create a session until reconnected".

   Toasts are left for messages that have nothing to do with the connection: session limit, input too large, notices from the agent.
2. **Startup shows the same banner from the first frame.** While the gate checks pairing, it renders a skeleton of the app in the device's form: the empty tab bar on `wide`, the terminal area, and the banner reading "Connecting…". When the app mounts, the banner is already where it will stay.
3. **An unreachable agent at startup is a banner too**: "Can't reach the agent · retrying" over the skeleton, in the error color. The gate re-checks every 3 seconds and on the `online` event, instead of staying on a dead status page until the user reloads.

## Consequences

- From page load through reconnects, connection messages appear in one place.
- On `wide` the status dot in the tab bar stays, as the permanent indicator.
- `conn-text` keeps its meaning (the state, visually hidden while online). The note is `conn-note`.
