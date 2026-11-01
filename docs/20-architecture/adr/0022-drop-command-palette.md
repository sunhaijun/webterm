# ADR-0022 Remove the command palette

Status: Accepted (2026-09-13). Takes back one of the four secondary screens [ADR-0018](0018-one-drawer-primitive.md) moved into `Drawer`, and voids AC-6.8 / US-6.6. The history panel, snippets ([ADR-0008](0008-pinned-history-as-snippets.md)), the `Drawer` primitive itself and the other shortcuts are unchanged.

## Context

The command palette (`Ctrl/Cmd+K`) was built in m7 as the single main entry point on desktop: one place for sessions, snippets, history and actions, in exchange for keeping shortcuts to a minimum. Once shipped, it didn't live up to that role. Everything in it already had a shorter, more specific path:

| In the palette | Existing path |
|---|---|
| History / snippets | The history panel (search + directory / failure filters + pin + labels + delete, a superset of the palette); chips in the edit panel; `↑` prefix history in the Composer |
| Sessions | The permanent sidebar (desktop), ⋯ → Sessions (phone / tablet), `Ctrl+Shift+↑/↓`, horizontal swipe |
| Actions (new session / settings / switch theme) | Mode bar buttons, the ⋯ menu, `Ctrl+Shift+Enter`, `Ctrl+Shift+,`, the theme picker in settings |

A universal entry point pays off when **there are too many candidates to remember** (hundreds of commands in an editor, thousands of files in an IDE). webterm's candidates are a single-digit number of sessions plus a dozen snippets. At that scale "open the palette → type → pick one" is slower than tapping the button directly, and the maintenance cost was real: a component, fuzzy matching and scoring, a shortcut, two entry points, a set of styles, a set of tests, and every change to `Drawer`, history or sessions had to account for it.

## Decision

1. **Delete the command palette completely**, with no toggle and no fallback entry: the component `web/src/commands/palette.tsx`, the fuzzy matcher `web/src/commands/fuzzy.ts`, the `Ctrl/Cmd+K` binding and the `'palette'` action, both entry points (mode bar and ⋯ menu), the `.palette-*` styles, and their unit and E2E tests.
2. **Give `Ctrl/Cmd+K` back to the terminal.** In readline, `Ctrl+K` kills to the end of the line (bash / zsh / emacs / fish all share it), and we had been intercepting a key terminals actually use at the app layer. Removing the palette fixes a real bug; it isn't collateral damage. Afterwards the design-constraint table in `keymap.md` reduces to one clean rule: **app shortcuts use only `Ctrl+Shift+*`**, with `Ctrl/Cmd+F` (in-session search, unused by terminals) as the only exception.
3. **No new shortcuts to make up for the lost entry point.** Keeping shortcuts to a minimum is still the goal; the reason changes from "the palette covers everything" to "there are few entry points and they're all on screen".

Rejected alternatives:

- **Keep it but hide it** (keep the shortcut, drop the two visible entry points). Hidden features go unused but still need maintenance, and it would keep holding `Ctrl/Cmd+K`.
- **Turn it into history-only search.** The history panel already has substring search and filters; a second, weaker search window would split the mental model.

## Consequences

- AC-6.8 and US-6.6 are void (struck through in the docs with a pointer to this ADR, not deleted, to keep the decision trail).
- The "command palette" case in E2E-14 is removed; E2E-28 goes from "four entry points share one shell" to three (sessions / history / settings).
- When the browser grabs `Ctrl+Shift+W` in a normal tab, the fallback is now the ✕ on each session in the session list (`session-<sid>-close`).
- `fuzzy.ts` had no other users and goes too. If fuzzy search across history is ever needed, add a match mode to the history panel rather than building another window.
- `Drawer` is unchanged, just with three users instead of four; [ADR-0018](0018-one-drawer-primitive.md)'s "one overlay primitive" conclusion stands.
