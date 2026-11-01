# ADR-0018 One overlay primitive for secondary screens: bottom sheet on touch, centered dialog on desktop

Status: Accepted (2026-09-12). Completes [ADR-0013](0013-terminal-only.md) §5 (native-style mobile chrome) by moving sessions, history, the command palette and settings into one `Drawer` primitive. The terminal as the only display surface, the input toggle ([ADR-0014](0014-input-toggle.md)) and the single key row ([ADR-0015](0015-bottom-keyrow.md)) were unchanged.

Later changes, in order:

- [ADR-0022](0022-drop-command-palette.md) removed the command palette; `Drawer` and its other three users (sessions, history, settings) stayed.
- [ADR-0025](0025-termux-style-ui.md) removed the ⋯ menu, the history overlay and the tablet session overlay. `Drawer` stayed, used by settings and the phone session drawer.
- [ADR-0030](0030-no-settings.md) removed settings, leaving the phone session drawer as `Drawer`'s only user and the bottom sheet as its only form. The centered dialog form was deleted.
- [ADR-0037](0037-settings-theme-and-font-size.md) brought settings back, and the centered dialog with them, but the form is now chosen by `compact` / `wide` instead of `pointer`: `compact` gets the bottom sheet, `wide` the centered dialog.

## Context

The four items in the ⋯ menu opened three completely different kinds of thing:

| Entry | Touch form | Scrim | Grabber | Title bar / close | Swipe to close | Radius |
|---|---|---|---|---|---|---|
| History | Bottom sheet (`.panel`, 86vh) | 45% | Yes (`::before`) | Only a row of tool buttons | Yes | 16px |
| Command palette | Bottom sheet (`.palette`, 80vh) | 45% | Yes (`::before`) | None | Yes | 16px |
| Sessions | Phone: bottom sheet (`.sidebar`, 70%); **tablet: left drawer** | 40% | No | None | Yes | 12px |
| Settings | **Not an overlay**: a `.banner` inside `.main` that pushed the terminal up | None | No | None | No | 0 |

The cause was timing, not design. The pass that unified everything into native bottom sheets only covered overlays, and settings had been a 12 px banner since the desktop mode-bar days, so it wasn't on the list. The session drawer pass only added swipe-to-close; its shape (radius, grabber, scrim, tablet sliding in from the left) never caught up.

The result: four taps in one menu gave four interaction conventions. Settings couldn't be dismissed by tapping outside, had no close button, and pushed the terminal up (losing the position you were reading). Sessions came in from the left on tablets while history, one row above it, came up from the bottom.

## Decision

1. **One overlay primitive, `Drawer`** (`web/src/ui/drawer.tsx`), used by **all** of sessions, history, command palette and settings. Fixed structure:
   ```
   scrim (click to close)
     └ sheet: grabber · title bar (title + optional tools + ✕) · scrolling body · optional footer
   ```
2. **The form depends on touch capability, not width.** `pointer: coarse` → bottom-anchored, full width, 16 px top radius, `sheet-up` animation, grabber, swipe down to close. `pointer: fine` → centered dialog, 14 px radius, no grabber. **Tablet sessions no longer slide in from the left**; like history and the command palette, they come up from the bottom.
3. **Closing works the same way on all four**: tap the scrim, press `Esc`, tap ✕, or (on touch) swipe down.
4. **Overlays never squeeze the layout**: `position: fixed`, and no more settings banner in `.main`'s flex column. Terminal geometry doesn't change when an overlay opens or closes, so the PTY gets no `SIGWINCH` (an old constraint from [ADR-0011](0011-read-first-layout.md); the settings banner was its only violation).
5. **The desktop (`≥ 1024px`) session sidebar stays a permanent column**, not an overlay. It's part of the main grid (`Ctrl+Shift+B` collapses it). Overlays only replace the phone / tablet drawer form.
6. **The one exception is the ⋯ menu**: on tablet / desktop it stays the 280 px popover anchored above the end of the key row ([ADR-0015](0015-bottom-keyrow.md) §7). The menu is a launcher for overlays, not an overlay itself.

## Consequences

- **Tablet users relearn once**: sessions move from a left drawer to a bottom sheet. In return there's one rule to remember, "everything in ⋯ comes up from the bottom", and on a 744 px tablet a bottom sheet list is easier to tap than a 280 px left drawer. A left-edge swipe was never implemented, so only the position changes.
- **On desktop the command palette moves from "top, 12vh" to centered.** Top anchoring is the palette convention, but its height is fixed (max-height 60vh, the list scrolls inside), so centering doesn't jump with the number of items. One consistent rule is worth more.
- **One more component layer.** The real cost was writing the header, scrim, gestures and Esc handling four times; `installSwipeDismiss` had already been pasted in three places.
- **With settings as an overlay, you can't watch the terminal while adjusting font size the way the banner allowed.** But font size applies to xterm live, the overlay covers only the lower part of the terminal, and one tap on the scrim shows it. The banner pushed the whole terminal up, which was worse.
- Docs: [layout.md](../../40-frontend/layout.md) (overlays), [session-ux.md](../../40-frontend/session-ux.md) (tablet uses a bottom sheet), [input.md](../../40-frontend/input.md) (all ⋯ items open the same kind of overlay), [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) (new E2E-28). Existing testids were kept; each overlay's ✕ got `drawer-close` (history kept `close-history`).
- Protocol, reconnect, connection layer and session state untouched.
