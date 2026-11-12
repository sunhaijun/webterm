# ADR-0060 The file browser: maximize, and Markdown rendered

Status: Accepted (2026-11-08); §2 "Looks" amended by [ADR-0061](0061-markdown-text-size.md) (text size, the size line stays at the top); §1 amended by [ADR-0066](0066-files-full-height-on-phones.md) (full height on phones too, reversing "Maximize on phones" below) and §2's Source button by the same ADR (an icon that stays pressed). Amends [ADR-0059](0059-files.md) §1 (sheet size on `wide`) and §4 (previews), and reverses its "Rendering Markdown" alternative. Adds AC-9.13 and AC-9.14 and E2E-54. Neither the HTTP API nor the protocol changes.

## Context

Two requests after using the file browser:

- **On a PC, the dialog is a fixed `min(720px, 100vw − 32px)` × `min(80%, 720px)`.** A wide log, a screenshot or a long document is read through a window a third of the screen. A desktop window would be maximized.
- **`.md` files show their source.** claude and codex write their plans, reports and summaries as Markdown, and most repositories document themselves in it. Tables and lists read badly as source on a phone.

ADR-0059 turned Markdown rendering down as "a sanitizer and an attack surface". Rendered Markdown is markup on webterm's origin, which has the device cookie and the WebSocket, so the way it is rendered has to leave nothing that can run.

## Decision

### 1. Maximize and restore (`wide` only)

- **A button left of ✕** in the header of the file list and of a file (`files-max`): a line-drawn square ("Maximize"), and once maximized two overlapping squares ("Restore"), `aria-pressed` accordingly. Double-clicking the header outside its buttons does the same, as on a desktop window's title bar.
- **Maximized, a sheet fills the visible area**: no margin, no corner radius, no border. The list and a file share the state, so a file still covers the list exactly. The name and delete sheets stay small dialogs.
- **Remembered per device** (`webterm.filesMax` in local storage, read inside `try`), like the extra keys' collapsed state ([ADR-0056](0056-collapsible-extra-keys.md)): a window you maximized stays maximized next time. It is window state, not a setting ([ADR-0030](0030-no-settings.md)).
- **`compact` has no button.** Phone sheets are bottom sheets at 80% and keep the grab handle and swipe-down.
- Like every sheet, it never changes terminal geometry.

### 2. Markdown rendered

- **Which files**: `.md` and `.markdown`, in any case. The first 512 KiB are rendered (as for text, [ADR-0059](0059-files.md) §4). The size line gets a **Source** button (`file-source`) that shows the text as before and then reads **Preview**. In Source, a file over 512 KiB has End as before. Rendered is the default every time a file opens.
- **The renderer**: [markdown-it](https://github.com/markdown-it/markdown-it) 15 (CommonMark, plus GFM tables and strikethrough), bundled into the frontend and loaded only when a Markdown file is first opened. `linkify` turns bare `http(s)://` URLs into links. `typographer` and `breaks` are off.
- **Raw HTML is off** (`html: false`). `<script>`, `<img onerror>` or `<iframe>` in a document come out as visible text, escaped, never as tags.
- **Links** are allowed to `http:`, `https:` and `mailto:`, to `#anchors`, and to relative paths. Anything else (`javascript:`, `file:`, `data:` and so on) stays plain text. A click:
  - `http(s)` and `mailto` open in a new tab with `noopener noreferrer`;
  - `#anchor` scrolls the preview to the heading with that id. Headings get GitHub-style ids: lowercased, punctuation dropped, spaces to `-`, and `-1`, `-2` added to repeats. In the page they carry an `md-` prefix (`#next-steps` finds `md-next-steps`), so a heading's id never collides with the page's own elements or shadows a `window` property;
  - **a relative path** is resolved against the file's folder (query and anchor dropped, `%`-escapes decoded) and opened in the browser. A file replaces the one shown; a folder closes the file and shows that folder in the list. Missing → a toast.
- **Images**: a relative `src` is loaded from the agent (`/api/fs/raw`, resolved like a link), so a README's screenshots show. Anything else isn't loaded: an `http(s)` image becomes a link carrying its alt text, and other schemes become the alt text alone. External images would tell a third party when and from where you read the file, and the page's CSP (`img-src 'self' data:`) would block them anyway.
- **Inserted once as HTML** markdown-it produced (the only `innerHTML` in the page). One click listener on the container handles every link: there are no inline handlers. The page's CSP (`script-src 'self'`, no `'unsafe-inline'`) is a second, independent barrier: even a tag or handler that slipped through couldn't run.
- **Looks**: the UI font at 15px (eight sizes from 12 to 24px since [ADR-0061](0061-markdown-text-size.md)), at most 760px wide (50em since ADR-0061), centered when maximized; code and tables in their own horizontal scroll; colors from the theme's variables.

## Alternatives considered

- **A sandboxed iframe** (`srcdoc`, no `allow-scripts`). It isolates the document completely, but links, anchors, theme colors and sizing all have to cross the frame. With raw HTML off and the CSP in place there is nothing for the frame to stop.
- **Our own small Markdown parser** writing DOM nodes. It is safe by construction but gets tables, nested lists and edge cases wrong, and those are what claude writes.
- **`marked`**: smaller, but it passes raw HTML through unless every renderer is overridden. markdown-it escapes it with one option.
- **DOMPurify on top.** It adds a dependency for HTML that `html: false` never emits; the CSP is the backstop.
- **Rendering by default only on phones**, or **remembering Source**: Markdown is read rendered almost always. Source is one tap and isn't remembered.
- **Maximize on phones**: the sheet already takes 80%, and full screen would hide the grab handle's area; nobody asked.
- **A keyboard shortcut for maximize**: the button and the double-click are enough. A shortcut would take a key from the terminal.

## Consequences

- One frontend dependency, markdown-it, in its own chunk fetched the first time a Markdown file opens (about 43 KB gzipped). `go:embed` serves it like every other asset.
- The threat model gains rendered Markdown (T5). The served-file headers (ADR-0059 §7) don't change: the preview is built from `/api/fs/raw`'s bytes by the page, not opened from it.
- Tests: UT-md-1 (escaping, links, images, ids, relative paths), UT-files-7 (the remembered state), E2E-54.
