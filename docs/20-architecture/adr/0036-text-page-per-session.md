# ADR-0036 The text page follows the session

Status: Accepted (2026-10-31). **Revises [ADR-0025](0025-termux-style-ui.md) §3 and the last rule in [session-ux.md, Focus follows the session](../../40-frontend/session-ux.md#focus-follows-the-session-ac-48)** (which said the text page belongs to no session: after switching, focus stays on the text page and its content goes to the current session). How the text page is opened, what Enter does and how content is sent ([ADR-0027](0027-text-page-enter-submits.md)) are unchanged.

## Context

ADR-0025 made the text page "the other page" of the extra-key area, with a single instance for the whole UI: which page is showing and what's in the field had nothing to do with the current session. The user reported that the text input didn't follow the session, and that switching sessions while editing left it showing in a way that made no sense.

The real scenario: in session A you're writing a prompt for claude, and halfway through you switch to session B to glance at build output. The text page is still open with A's half-written prompt in it; press Enter now and it goes to B. When you write a prompt, you have a target session in mind.

## Decision

### 1. Each session has its own page and draft

- **Page**: the key page or the text page. Tapping ✎ or swiping on the key area changes only the current session's page.
- **Draft**: what's in the field and not yet sent. Sending with Enter clears only the current session's draft.
- **Switching sessions** (tab, drawer, `Ctrl+Shift+↑/↓`, or the automatic switch to a neighbor after closing the current one) swaps the extra-key slot to the new session's page and the field to its draft; switching back restores them exactly.
- **New sessions** start on the key page with an empty draft. A closed session's draft is discarded. When the agent restarts (all sessions invalidated), all drafts are discarded.
- Drafts live **only in memory**: a page reload loses them, as before. They aren't stored in `localStorage`: sids are reused after an agent restart, so a stored draft could land in an unrelated new session.

### 2. Focus follows the session to its input

The [AC-4.8](../../10-requirements/acceptance-criteria.md) rule extends to the text page:

```
typing = before the switch (or, when switching from the drawer, before the drawer opened) focus was in the terminal or in the text field
after the switch: typing || non-touch device  →  new session on the text page: focus the text field
                                                 new session on the key page:  focus the terminal
```

- Typing on A's text page, switching to B on its key page: focus goes to B's terminal and the on-screen keyboard stays up.
- Typing in A's terminal, switching to B on its text page: focus goes to the field, with B's draft in it.
- On touch devices with no focus before the switch: still don't focus anything (don't pop the keyboard).

Focusing happens inside the click / key handler, so iOS keeps the keyboard.

### 3. Switching during IME composition: commit first, then swap

If the field is mid-composition (IME candidates not yet chosen) when the session switches (possible on an iPad, where tapping a tab doesn't blur the field), first blur the field so the IME commits the composed text into it, save that as the old session's draft, then swap the content. Setting `value` directly makes the IME drop the half-composed text, or with some IMEs insert it into the new session's draft.

### Implementation

Still one `textarea`; switching swaps its `value` rather than creating one per session. There's only one extra-key slot, and the field's attributes (AC-3.10) and geometry only need setting once. Pages and drafts are kept in `AppController` (`TextPages`, keyed by `sid`); the extra-key component only displays the current session's page.

### Rejected alternatives

- **Close the text page and clear the draft on switch.** Simple, but one switch wipes a half-written long prompt and the user has to rewrite it.
- **Close the text page on switch but keep the draft with its session.** Returning to A then needs another tap on ✎ to continue; A being on the text page was the user's own choice.
- **Share one draft globally and warn on send that the target session changed.** One more warning and confirmation; the user wants not to have to think about it.

## Consequences

- Adds AC-3.22; rewrites AC-4.8 (focus goes to the new session's input).
- E2E-40 adds ⑨ (Pixel 5, switching between two sessions: pages and drafts stay with their sessions, Enter sends only to the current one).
- Switching during composition (§3) can only be verified on a real device; it goes in the manual checklist.
