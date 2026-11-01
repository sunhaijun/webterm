# ADR-0037 Settings return with two items, theme and terminal font size; the session drawer gets a minimum height and bottom breathing room

Status: Accepted (2026-10-31). **Partly supersedes [ADR-0030](0030-no-settings.md)**: §1's "theme only follows the system, fixed font size, no settings entry" and §2's "overlays are only a bottom sheet". ADR-0030 §1's "font fixed to the system monospace stack" and "`Ctrl+Shift+,` not intercepted", and §3's session button, are unchanged. Revises [ADR-0018](0018-one-drawer-primitive.md)'s overlay forms again.

## Context

After ADR-0030 removed settings entirely, the user asked for a simple settings page back in the same place as before, offering only the theme and the font size, with everything else left at defaults.

The same round raised three more points:

- On phones the session drawer is too short with few sessions (with one session: a title bar, one row and a button).
- The buttons at the bottom of the drawer sit flush against the screen's bottom edge; the layout needs breathing room.
- The settings icon should match the existing icons. The old ⚙ was a Unicode character: glyphs differ across platforms, some render as color emoji, and it didn't match the line-drawn `+` in the tab bar ([ADR-0035](0035-tabbar-new-button-pinned.md) §3).

ADR-0030 removed settings for two reasons, and this version respects both. Too many items needing explanation: now there are two, with no explanatory text in the UI ([ADR-0028](0028-settings-without-notes.md)'s principle). Settings must be redone on every device: still true, but the defaults are already chosen per device and most people won't need to change them.

## Decision

### 1. Two settings only

| Item | Values | Default | Storage (`localStorage`) |
|---|---|---|---|
| Theme | System / light / dark | System | `webterm.theme`: `system` / `light` / `dark` |
| Terminal font size | Integer 10–24px, step 1 | 14px | `webterm.fontSize` |

- **Theme**: choosing light or dark sets `data-theme` on `<html>`, and the UI and xterm switch together without a reload; choosing system removes the attribute and falls back to `prefers-color-scheme`. A forced theme also sets `color-scheme`, so scrollbars and native controls follow. **The theme is applied before first render** (`main.tsx`), including on the pairing and gate pages, so there's no light-then-dark flash.
- **Font size**: change all xterm instances together, `fit()` the current one, **then send an extra `resize`**. The cell size changed but the container didn't, so `ResizeObserver` won't fire, and skipping the `resize` leaves the client and PTY disagreeing on cols/rows (the old AC-5.3 trap). When the column count changes, the agent resends a snapshot as usual ([ADR-0026](0026-agent-holds-terminal-state.md) §4).
- **One font size, not one per form.** The form is decided by the screen's short side and never changes on a given device ([ADR-0025](0025-termux-style-ui.md) §1), and `localStorage` is per browser. Storing one per form means a device only ever uses one of them.
- **The font isn't a setting**; it stays the system monospace stack (ADR-0030 §1).
- **Changes apply immediately**: no "save" and no preview row, since the terminal itself is right behind the overlay.
- If storage is unreadable (private window, site data disabled) or a value is invalid, use the default without an error. Keys left by older versions (`webterm.fontSize.compact` / `.wide`, `webterm.font.family`) aren't read.

### 2. Entry points return to where they were; no shortcut

- `wide`: at the right end of the tab bar, right of the connection status dot, `data-testid="open-settings"`, 36px wide, same height as `+`.
- `compact`: at the bottom of the session drawer, right of "+ New session", a 48px square button, `open-settings`. Tapping it closes the session drawer, then opens settings.
- **`Ctrl+Shift+,` stays unbound** and goes to the terminal (ADR-0030 §1). Settings change a few times a year; they don't deserve a key combination.

### 3. Icons: one line-icon style

All icons the UI draws itself use one style: **inline SVG, stroke only, no fill, `stroke="currentColor"`, 1.75px stroke, round caps and joins**. Used for:

- the tab bar's `+` (already, per ADR-0035 §3) and ⚙;
- the session drawer's bottom `+` (previously the character "+") and ⚙;
- the `−` / `+` for font size in settings.

⚙ is a six-tooth gear (outer outline plus a round hole in the middle), in the same 14×14 box as `+`. Its color follows the button: `--muted` normally, `--fg` on hover.

### 4. Two overlay forms, by device form

| | `compact` (phone) | `wide` (PC / tablet) |
|---|---|---|
| Form | Bottom-anchored full-width sheet: grab handle, swipe down to close | Centered dialog, width `min(420px, 100vw − 32px)`, 14px corner radius |
| Used by | Session drawer, settings | Settings |

Split by form rather than by `pointer` as ADR-0018 originally did: a tablet is touch but wide, and a bottom sheet stretching 1024px with two settings rows is mostly empty space; iPadOS's own modals are centered too. The session drawer only appears on `compact`, so it's always a sheet.

Closing works as before: tap the backdrop, `Esc`, ✕, or (sheet) swipe down. Settings doesn't hook the system back button: when switching from the session drawer to settings, the drawer calls `history.back()` to remove its entry, which is asynchronous, and settings would then `pushState` immediately after; their order isn't reliable. After settings closes, return focus if it was in the terminal (or the text page) before opening, or if the device is non-touch.

### 5. Session drawer height and bottom spacing

- **Minimum height 50% of the viewport**, maximum still 80%. Half is iOS's "medium" sheet detent, so a drawer with few sessions isn't just a strip. The extra height goes to the list, and the bottom row stays pinned to the bottom of the sheet. The settings sheet has only two rows and no minimum height.
- **Breathing room around the bottom row**: 12px top, 16px left and right, `max(16px, env(safe-area-inset-bottom))` bottom. Buttons are 48px tall with 12px corner radius, a `--surface` background and a thin `--line` border, 12px apart. No more edge-to-edge flat buttons.
- Sheets without a bottom row (settings) also leave `max(16px, env(safe-area-inset-bottom))` at the bottom.

### Rejected alternatives

- **Make the accent color configurable too.** We read the user's "theme color" as the theme (light/dark), as in the earlier settings. The accent color specifically means "this is selected" ([layout.md, Theme](../../40-frontend/layout.md#theme)); changing it requires re-checking contrast on both backgrounds, and it's one more item.
- **A number input for font size** (the old settings panel). On a phone, tapping it opens a numeric keyboard that covers the bottom half of the screen; `−` / `+` step one at a time without a keyboard.
- **A dropdown for the theme.** Three options laid out as a segmented control show the current choice at a glance and switch with one tap.
- **One font size per form.** See §1.
- **Overlay form by `pointer`.** See §4.
- **A full settings page (a route).** Two settings don't justify a page, and it would take the terminal away.

## Consequences

- AC-5.3 rewritten as "appearance has two settings"; AC-5.11 becomes two overlay forms plus the session drawer's minimum height and bottom spacing; AC-4.10's drawer bottom row becomes "+ New session" and ⚙.
- E2E-12 ② checks default system theme, changing theme and font size, and persistence across reloads; E2E-28 ① gets an `open-settings` in the bottom row, plus new ⑦ (height and spacing) and ⑧ (open settings from the drawer); E2E-41 ① checks `open-settings` at the right end of the tab bar aligned with the status dot, plus new ⑩ (centered dialog, focus returns to the terminal on close).
- Frontend adds `ui/prefs.ts` (read/write the two preferences, apply the theme) and `app/settings.tsx`; `Drawer` again has two forms by device form; SessionStore again changes font size on all instances; the controller's `measure` gets `force` back. The dark-theme CSS variables are written twice again (in the media query and under `[data-theme=dark]`).
- If m10's pinch-to-zoom happens, it changes this same value.
