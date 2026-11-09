# ADR-0048 Sign out this device

Status: Accepted (2026-11-04); §1 amended by [ADR-0062](0062-several-machines.md) §12: `Clear-Site-Data` no longer includes `"cookies"` (its scope is the whole registrable domain) and goes only to the agent's own origin, and with several machines signing out covers each of them (§11). Builds on [ADR-0037](0037-settings-theme-and-font-size.md) (settings) and [ADR-0038](0038-close-confirm-sheet.md) (in-app confirmation).

## Context

A paired device holds one credential: the `webterm_session` cookie. It is `HttpOnly`, so the page can't delete it. Until now a device could only be revoked on the server (`webterm devices revoke`) or through the API. Clearing site data in the browser removes the cookie, but the token is still valid on the server, so a copy of it would keep working.

Nothing else on the device is sensitive. Terminal output exists only in memory (invariant 3), `localStorage` holds the theme and font size, and the service worker caches only the static shell.

## Decision

1. **`POST /auth/logout`**. It requires a valid device session and passes the same `Origin` check as other state-changing requests ([ADR-0047](0047-review-fixes.md) §3). It revokes the requesting device, clears the cookie, and sends `Clear-Site-Data: "cookies", "storage", "cache"`, then replies `204`. The device's other tabs lose their WebSocket within 5 seconds through the existing revocation scan (AC-1.11).
2. **The page clears what it can as well**: every `webterm.*` key in `localStorage`, the service worker registration, and the Cache Storage. `Clear-Site-Data` does all of this in Chromium and Firefox, but not everywhere (Safari). Then the page shows the pairing page with "Signed out".
3. **Entry point**: a "Sign out this device" button at the bottom of Settings. It is an action, not a setting; ADR-0037's two settings stay two. It asks for confirmation first, using an in-app sheet like the close confirmation.
4. **Online only.** Offline the button says it can't sign out yet. Clearing only the local copy would leave a token the server still accepts, which is exactly what signing out is meant to end. A `401` reply counts as success, because the device is not authorized either way.
5. A device that is lost, or not in your hands, is still revoked from the server: `webterm devices revoke <id>`.

## Consequences

- When you give a device up, nothing left on it can reach the agent, and the server no longer accepts its token even if a copy exists.
- Sessions keep running on the server. Using the device again needs a new pairing code.
