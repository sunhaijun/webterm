# ADR-0030 No settings: theme follows the system, size and font use defaults; the session button shows the session count

Status: Accepted (2026-10-31). **Supersedes [ADR-0023](0023-terminal-font-list.md) (terminal font list) and [ADR-0028](0028-settings-without-notes.md) (no notes in the settings panel).** Revises [ADR-0025](0025-termux-style-ui.md) §2 (m9's configurable key layout), §4 (☰ and ⚙), §5 (font size via settings before m10), §7 (`Ctrl+Shift+,`) and §8 (the config-file row), and the two overlay forms of [ADR-0018](0018-one-drawer-primitive.md).

Later: **§1's theme and font size, and §2's overlay form, are superseded by [ADR-0037](0037-settings-theme-and-font-size.md).** Settings came back with only theme (system / light / dark) and terminal font size, reached from the right end of the tab bar and the bottom of the session drawer; overlays are a bottom sheet or a centered dialog depending on the form. The fixed font, the unbound `Ctrl+Shift+,`, and §3's session button are unchanged.

## Context

The m8 settings panel had four rows: theme (system / light / dark), terminal font size (stored per form), terminal font (picked from fonts detected on the device), and a preview. It had three entry points: ⚙ at the right end of the `wide` tab bar, "⚙ Settings" at the bottom of the phone's session drawer, and `Ctrl+Shift+,`.

After trying it, the user's verdict was that the settings button and everything behind it were unnecessary: the theme should just follow the system, and everything else should use defaults.

What these settings cost:

- Code: the settings overlay, `prefs.ts`, `fonts.ts` (canvas detection), and three paths in the controller for font size, font and theme, each of which must send an extra `resize`. The dark-theme CSS variables had to be written twice, once in the media query and once under `[data-theme=dark]`. The centered-dialog overlay form existed only for settings.
- Use: preferences live in this browser's `localStorage`, so every new device starts over. The defaults were already chosen per device (14px on a portrait phone gives about 45 columns, see [devices-and-layout.md](../../10-requirements/devices-and-layout.md)).

The same round of feedback said the icon for opening the session drawer didn't fit. On phones ☰ conventionally means "menu", but it opened a list of sessions.

## Decision

### 1. No settings at all

- **The theme follows the system** (`prefers-color-scheme`). When the system switches between light and dark, the UI and xterm switch together without a reload.
- **The terminal font size is fixed at 14px** in both forms.
- **The terminal font is the system monospace stack**, the CSS `--font-mono`, with a CJK monospace fallback.
- Removed: the settings overlay; both ⚙ entry points (tab bar and drawer); `Ctrl+Shift+,` (no longer intercepted; it goes to the terminal); the `localStorage` keys `webterm.theme`, `webterm.fontSize.*` and `webterm.font.family`. Values left in existing browsers are no longer read and aren't cleaned up; they're harmless.
- Only two things still change terminal geometry at runtime: visual viewport changes (on-screen keyboard, rotation, window resize) and a change in `pointer: coarse`.

### 2. One overlay form: the bottom sheet

On `wide`, the only overlay was settings, and it was the only user of the centered-dialog form. The session drawer appears only on `compact`, which means phones.

So `Drawer` becomes a single bottom-anchored, full-width sheet: grab handle, swipe down to close, and the system back button work as before, with no split by `pointer`.

### 3. Session button: a rounded square with the session count

☰ is replaced by something that looks like a mobile browser's tab switcher: a rounded square with the number of open sessions inside. Phone users know this button (Chrome, Safari and Firefox all use it to switch tabs), so a list of sessions is what they expect to see. The number also tells them how many sessions are open.

- Position, size and testid are unchanged: top cell of the extra keys' left column, `open-sessions`.
- The unread dot stays, on the top-right corner of the square, with a ring in the background color to separate it from the square's border.
- The number uses the bold UI font; two digits fit (the default session limit is 20).

### Rejected alternatives

- **Keep only the theme.** The user said "the theme should follow the system".
- **Move font size to shortcuts** (`Ctrl+=` / `Ctrl+-`). That hides a setting rather than removing it, and `Ctrl+-` is `^_` in a terminal, a collision.
- **Keep the centered-dialog form.** Without settings, only a device with a short side under 600px *and* a mouse would ever see it; that hardly exists.
- **Use a Unicode character for the session button** (`⧉`, `❐`, …). Glyphs vary a lot across platforms, some render as emoji, and none of them reads as "sessions".
- **Show the current session's number on the button.** The drawer already shows `[n]`; on the button, users care more about how many are open.

## Consequences

- Theme, font size and font changed in older versions are ignored; everyone is back to the defaults.
- **m9's configurable key layout is dropped too**: it needs an editing UI, which contradicts "no settings". Swipe-up secondary keys and auto-repeat are unaffected.
- **m10's pinch-to-zoom stays on the roadmap**: it's a gesture, not a setting. Until m10, the font size is fixed at 14px.
- AC-5.13 deleted; AC-5.3 rewritten as "appearance has no settings"; in AC-4.10, AC-5.11 and AC-5.18, ☰ becomes the session button and overlays have only the sheet form.
- E2E-12 ② now checks "follows the system, no settings entry point" and ⑤ is deleted; E2E-28 drops the centered dialog and ⑦, and ① asserts the session count; E2E-41 ① drops ⚙; E2E-42 ② changes columns by narrowing the window.
- Frontend deletes `app/settings.tsx`, `ui/prefs.ts`, `ui/fonts.ts` and their unit tests.
