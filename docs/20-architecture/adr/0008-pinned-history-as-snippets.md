# ADR-0008 Snippets are pinned history

Status: Accepted (2026-09-06). Superseded by [ADR-0025](0025-termux-style-ui.md) §10: the history panel and snippets went away with the old UI, and the `commands` table and `/api/commands` were removed in step 2.

## Context

The requirement was snippets plus command history, with "add from history" as the default way to create a snippet, and the design and experience kept simple.

The first design made snippets a separate entity with parameterized templates (`docker logs -f {{container}}`; clicking opens a form to fill in parameters).

## Decision

**A snippet is not a separate entity. It is a `pinned` flag on the `commands` table.**

```sql
commands(
  id, text, session_name, cwd, exit_code, started_at, duration_ms,
  pinned    INTEGER DEFAULT 0,   -- pinned = snippet
  label     TEXT,                -- optional short name, e.g. "restart service"
  pin_order INTEGER              -- order among pinned rows
)
```

**No parameterized templates. Clicking a snippet always fills the Composer for editing.**

"Pick a similar command from history, change two characters, press Enter" already covers what template parameters do, faster and more flexibly:

```
Template form:  click → dialog → find field → type → confirm → run   (5 steps, only preset slots editable)
Fill Composer:  click → edit → Enter                                 (3 steps, edit anything anywhere)
```

Template parameters compensate for the lack of a good editor. The Composer ([ADR-0007](0007-dual-mode-input.md)) is a good editor, so templates have no reason to exist.

Interaction:

- **Create**: a ☆ on the right of each history row; one tap pins it. This is the only main path.
- **One list, two views**: pinned rows float to the top as the snippet section, history follows in reverse time order. One search covers both.
- **Click** fills the Composer with the cursor at the end. **Nothing runs automatically.**
- **Run directly**: `Shift+click` on desktop, long press on mobile. One less option, one less setting.
- **Mobile**: a horizontally scrolling row of buttons above the Composer, the `pinned` rows in `pin_order`. Long press to reorder or unpin.
- **Optional label**: a pinned row can be named. The button shows the `label` if set, otherwise the truncated command.
- **Secondary path**: creating a command that has never run lives in the snippet panel, off the main path.

## Consequences

Positive: one table instead of two (`snippets` + `commands`), `PATCH /api/commands/:id { pinned }` instead of a snippet CRUD API, one list and one search instead of two, no template parsing, form rendering or parameter validation, a ☆ instead of a creation form, and one concept plus a flag for users instead of two concepts.

Negative:

- Snippets share history's lifecycle, so **eviction must protect pinned rows**: past the history cap (default 50,000), the oldest **unpinned** rows are evicted; pinned rows never are (AC-6.10).
- A manually created, never-run command is a `commands` row with `started_at = now` and `exit_code` and `duration_ms` NULL. Semantically awkward (it isn't history), but the simplification is worth it. Such rows are identifiable by `exit_code IS NULL AND duration_ms IS NULL`.
