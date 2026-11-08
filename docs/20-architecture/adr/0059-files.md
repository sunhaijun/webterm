# ADR-0059 Files: browse, view, download and upload

Status: Accepted (2026-11-08); §1 (maximize on `wide`) and §4 (Markdown rendered) amended by [ADR-0060](0060-files-maximize-and-markdown.md). The first item of v0.2 ([milestones](../../90-roadmap/milestones.md), [non-goals](../../00-overview/non-goals.md) §2). Adds `/api/fs/*` to the [HTTP API](../../30-protocol/http-api.md#files), US-9 and AC-9, and amends invariant 3. The WebSocket protocol, the handoff snapshot and the terminal emulator are unchanged.

## Context

The agent runs as the user on the machine the files are on, so it could hand them to the browser. Today it doesn't:

- **Getting a file off the server** from a phone has no path at all. A log can be `cat`ed into the terminal; an image claude generated, a PDF report or a build artifact can't be seen or saved.
- **Putting a file somewhere** means sending it to a session ([ADR-0051](0051-send-files-to-a-session.md)), which lands in the temp directory under a generated name, and then typing `mv` on a phone keyboard.
- **Showing claude a file that is already on the server** (a screenshot a test run wrote) means typing its path.

ADR-0051 §5 deliberately served nothing back: a file served from webterm's origin that the browser renders as a page (an `.html` or `.svg` in a cloned repository) runs with the device cookie, opens the WebSocket and types into a shell. Serving files means solving that, not avoiding it.

[ADR-0013](0013-terminal-only.md) keeps the terminal as the only display surface. The file browser is a tool you open and close over the terminal, like the copy view planned for m10, and it never changes terminal geometry.

Measured with a real PTY (claude 2.1.319, codex 0.166.0, 2026-11-08), a bracketed paste of one path to a PNG, no Enter:

| Pasted | claude | codex |
|---|---|---|
| `/d/shota.png` | `[Image #1]` | `[Image #1]` |
| `/d/shot a.png` (as is) | `[Image #1]` | plain text |
| `'/d/shot a.png'` or `"/d/shot a.png"` | `[Image #1]` | plain text |
| `/d/shot\ a.png` | `[Image #1]` | plain text |
| `'/d/it'\''s.png'` | plain text | plain text |
| `/d/it\'s.png`, `/d/shot\ \(1\).png`, `/d/a\[b\]\&c.png`, `/d/截图\ \$x.png` | `[Image #1]` | — |

A backslash before each special character is what a local terminal types when a file is dropped on it. claude accepts it in every case tried and a shell reads it correctly. codex attaches no path with a space in it, however it's written.

## Decision

### 1. Sheets, the same as sessions

Every part of the file browser is a sheet built on the `Drawer` primitive ([ADR-0018](0018-one-drawer-primitive.md)). On `compact` that means a bottom sheet like the session drawer, with the grab handle and swipe down to close. Sheets stack: a file over the list, a rename or delete sheet over either. On `wide` the same sheets are centered dialogs.

- **The file list (`files-sheet`)** and **a file (`file-sheet`)** have a **fixed height**, 80% of the visible area on `compact` and `min(80%, 720px)` on `wide`. A file sheet covers the list exactly, and the list doesn't jump as you move between folders of different sizes. On `wide` they are `min(720px, 100vw − 32px)` wide.
- **New folder, rename and delete** use the same small sheets as session rename and close confirmation ([ADR-0039](0039-drawer-row-swipe-actions.md) §2, [ADR-0038](0038-close-confirm-sheet.md)).
- **The system Back button closes the top sheet**, and only that one: a file, then the list. Every file sheet pushes a history entry. Opening and closing them leaves `history.length` where it started, plus at most one entry per open sheet.

### 2. Where it opens

- **Entry points**: on `compact` the session drawer's bottom row becomes `+ New session · files · ⚙`, with files a 48px square like ⚙ (`open-files`). On `wide` the tab bar gets a files button (`open-files`) left of the paperclip. Both use a line-drawn folder icon. Opening files closes the session drawer, as settings does.
- **It opens in the current session's working directory** (`cwd`, which the agent already reports, [ADR-0026](0026-agent-holds-terminal-state.md) §6), or in the home directory when there is no session or no `cwd` yet.
- **It remembers where you were**. Reopened for the same session while that session's `cwd` is unchanged, it opens in the last folder you were in. After a `cd` it opens in the new `cwd`. This memory is per session and lives in the page only.

### 3. The list

```
┌──────────────── ═══ ────────────────┐
│ ‹  ~ / github / webterm / docs   ✕  │  up · path (each part a button, scrolls sideways) · close
│ ┌─ Filter ────────────────────────┐ │
├─────────────────────────────────────┤
│ ▢ 20-architecture           11-07  │  folders, then files, then hidden ones (dimmed)
│ ▢ README.md         4.2 KB  14:05  │  tap: open · swipe left / long-press / right-click: Rename · Delete
├─────────────────────────────────────┤
│ ┌───────────────────┐ ┌────┐ ┌────┐ │
│ │     ⇪ Upload      │ │ ▢+ │ │ >_ │ │  upload · new folder · new session here
└─────────────────────────────────────┘
```

- **Header**: `‹` goes up one folder (disabled at `/`). The path follows, `~` for the home directory, and each part is a button that goes there. The path scrolls sideways and starts scrolled to its end. ✕ closes.
- **Filter**: a text field under the header. It keeps the rows whose name contains the text, ignoring case, and is cleared when the folder changes.
- **Rows** are 52px, like the session drawer's. Each has a line icon (folder or file), the name, and on the right the size (files only) and the modification time: `14:05` today, `11-07` earlier this year, `2025-11-07` before that.
- **Order**: folders, then files, then hidden folders, then hidden files. A name starting with `.` is hidden. Hidden entries are dimmed, not filtered out, so there is nothing to switch on. Within each group, names sort naturally (`file2` before `file10`) and ignore case.
- Symbolic links behave like what they point to. A broken link is a file that can't be opened.
- **A name that isn't valid UTF-8** (GBK names from a Windows zip, say) can't travel through JSON intact. Its row shows the name with `�`, dimmed, and does nothing when tapped or swiped; the terminal can still rename it.
- **Every action keeps the full path it started on**, and the path row changes only when the new folder's listing arrives, so a tap on a row while another folder loads can't act on a different folder.
- **Tap a folder** to open it. **Tap a file** to open its sheet.
- **Row actions** work as on session rows ([ADR-0039](0039-drawer-row-swipe-actions.md) §1). Swiping left or long-pressing reveals two 72px buttons, **Rename** and **Delete**. Right-clicking with a mouse does the same. Only one row is open at a time.
- **A folder that can't be read** shows one muted line in place of the rows ("Permission denied", "Not found"). The header still works.
- **More than 5,000 entries**: the agent sends the first 5,000 by name, and a last muted row says how many more there are.

### 4. A file

- The title is the file's name. The first line of the body gives its size and full modification time (`4.2 KB · 2026-11-08 14:05`).
- **Preview**, chosen by extension and then by content:

| Kind | Extensions | Shown as |
|---|---|---|
| Image | png jpg jpeg gif webp avif bmp ico svg | `<img>`, fitted to the sheet; a tap toggles actual size, scrolling |
| Video | mp4 m4v webm mov ogv | `<video controls playsinline>` |
| Audio | mp3 m4a aac wav flac ogg oga opus | `<audio controls>` |
| No preview | pdf, and anything whose first 8 KiB contains a NUL byte | the file icon, nothing else |
| Text | everything else | the first 512 KiB as UTF-8 in monospace, wrapped |

- **Text over 512 KiB** gets a small **End** button at the right of the first line, which shows the last 512 KiB (a `Range` request, starting after the first newline) and then reads **Start**. Logs are read from the end. It isn't a third foot button: three don't fit a phone's width with "Send to session" readable.
- **Foot**: two equal buttons.
  - **Share or Download.** On a touch device (`pointer: coarse`) that can share the file (`navigator.canShare({files})`, which also decides by type) and for files up to 100 MiB, it's **Share**. The page fetches the file and hands it to the system share sheet: Save to Files, Save Image, AirDrop, another app. The fetch goes through the page, which holds the cookie, so it doesn't depend on whether an installed PWA shares cookies with the browser. If the browser refuses because the tap is too old by the time the file arrives, the button reads Share again and the next tap shares at once. Everywhere else it's **Download**: a same-origin link with `download=1`, so the browser's download manager streams the file and can resume it.
  - **Send to session**: pastes the file's path into the session the browser was opened from, through the same path as ADR-0051 §3 (`term.paste` inside `asUserInput`, counted and resent like any input). Every character other than letters (any script), digits and `_ . / , : @ % + = -` gets a backslash in front (table above). A path containing a control character (C0, DEL or C1) is **never pasted**, and the button is disabled for it: pasted raw, an ESC could end the bracketed paste early and a newline would press Enter, so a file named by a cloned repository or an unpacked archive could type and run a command. Then every file sheet closes and focus returns as it does after settings. It's disabled when that session isn't running.

### 5. Upload, new folder, rename, delete, new session here

- **Upload** opens a file picker for any type, several at once, from inside the click (iOS requires that). While the file browser is open, files dropped anywhere on the page go into the folder it shows, and the sheet gets the outline: the browser is modal, so the page around it isn't the terminal. With the browser closed, a drop still sends them to the session (ADR-0051). Files go one at a time, in order, to the folder that was shown when they were picked. While they upload the button reads `Uploading 45%` (`2/3 · 45%` for several) and is busy. When each finishes the list reloads if it still shows that folder. Closing the sheet doesn't stop uploads.
- **The original name is kept, and nothing is ever overwritten.** If the name is taken, the agent saves `<stem>-1<ext>`, then `-2` and so on, and a toast says `Saved as <name>`. A dash rather than ` (1)`, so the new name needs no quoting in a shell.
- **New folder** opens a name sheet (Create). **Rename** opens one with the current name, the part before the extension selected (Save). If the name is taken, a toast says so, the sheet stays open, and nothing is replaced.
- **Delete** asks first, in the close-confirmation sheet: `Delete "<name>"?`, then one sentence ("Everything in it is deleted too." for a folder, "This can't be undone." for a file), then Cancel and **Delete** in the warning color, with focus on Delete. Nothing goes to a trash folder.
- **New session here** (`>_`) creates a session whose working directory is the folder shown, closes every file sheet and switches to it, exactly like New session.

### 6. `/api/fs/*`

The [HTTP API](../../30-protocol/http-api.md#files) has the details. In short:

```
GET    /api/fs/list?path=/abs/dir                 → {path, entries: [{name, type, size, mtime}], total}
GET    /api/fs/raw?path=/abs/file[&download=1]     → the file (Range, ETag, conditional requests)
POST   /api/fs/upload?dir=/abs/dir&name=<name>     → body = the file → 201 {path, name, size}
POST   /api/fs/mkdir   {"dir": "/abs/dir", "name": "new"} → 201 {path}
POST   /api/fs/rename  {"path": "/abs/x", "name": "y"} → 200 {path}
DELETE /api/fs?path=/abs/x                         → 204
```

- **HTTP, not the WebSocket**, for the reason in ADR-0051 §4: one WebSocket carries every session, and a large transfer on it would hold up their output.
- **The agent user's permissions are the only fence.** Paths are absolute and cleaned, symbolic links are followed as the system follows them, and nothing is limited to the home directory. A paired device already has a shell with exactly these rights, so a fence here would only get in the way (`/var/log`, `/etc`) without stopping anyone. Delete and rename refuse `/` and the home directory itself, also when reached by another path (`/home` a symlink to `/var/home`); a link to either is just a link.
- **Names travel separately from folders** (`upload`, `mkdir`, `rename` take a folder or path plus one name), and a name must be one path component, so `../x` or `a/b` never lands somewhere else.
- Every route requires a device cookie. The writes check `Origin` like the other writes ([auth-pairing.md](../../60-security/auth-pairing.md#route-authentication-matrix-ac-17)).
- **Uploads stream to disk.** The body goes to a hidden `.webterm-upload-<12 hex>.part` in the target folder (the same file system, so the final rename is atomic). It is created exclusively with mode `0666` minus the umask, like any program's files, and moved into place with a rename that never replaces (`renameat2(RENAME_NOREPLACE)`, or a check and a rename where the file system lacks it). An interrupted request deletes the part file. There is no size limit beyond the disk; a full disk fails the upload and leaves nothing.
- **Only regular files are served.** A device, FIFO or socket is `400` and is refused before it is opened (opening a device can have side effects); the open never blocks on a FIFO. `http.ServeContent` provides `Range`, `If-None-Match` (the `ETag` is size + modification time), `If-Modified-Since` and `HEAD`, so video seeks and interrupted downloads resume.
- Logs don't contain paths or names. Operations and sizes are logged only at debug level.

### 7. A served file never runs on webterm's origin

Raw responses carry three defenses:

1. **`Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox`.** Even a document the browser does render gets an opaque origin, no cookie and no scripts. `Cache-Control: no-store` keeps a viewed `.env` or key out of the browser's disk cache.
2. **`Content-Disposition: attachment`** for everything except images other than SVG, video and audio, which are `inline` unless `download=1`. `<img>` and `<video>` ignore the disposition, so the preview works either way. Opening a raw URL as a page downloads anything that could be a document. The filename is RFC 5987-encoded.
3. **`X-Content-Type-Options: nosniff`** (already on every response), and a `Content-Type` from webterm's own table of extensions, `application/octet-stream` otherwise.

The page itself never turns a file into markup. Text previews go in as `textContent`, SVG only through `<img>` (which runs no scripts), and names render as text. There is no Markdown or HTML rendering.

### 8. What doesn't change

ADR-0051's sending stays as it is: an attachment for a session, in the temp directory, under a shell-safe generated name. The file browser is for files you mean to keep somewhere. The protocol, `seq`, the ring buffer, the emulator and the handoff snapshot are untouched: the routes are stateless, and a hot upgrade only cuts the transfers in flight. An upload cut that way leaves its hidden part file, the one thing the agent doesn't clean up.

**Invariant 3** gains a clause: files the user uploads through the file browser go where the user puts them.

## Alternatives considered

- **A full-screen page or a side panel.** Sheets match the session drawer, which the phone already uses daily. A page would be a second display surface (ADR-0013) and a second navigation model.
- **Back goes up a folder.** It would make Back mean something different in this sheet from every other one. `‹` and the path go up.
- **Limit to the home directory, or a configured root.** See §6: it doesn't stop a paired device and breaks real uses.
- **Over the WebSocket.** It would stall every session's output during a transfer.
- **Download tokens in the URL**, so a link works without the cookie. Share fetches through the page instead, and desktop links carry the cookie. A token would be a bearer secret in URLs, history and logs.
- **A toggle for hidden files.** It would be a setting ([ADR-0030](0030-no-settings.md)). Hidden entries come last, dimmed.
- **Overwrite on upload, or ask.** Asking costs a sheet per conflict, and overwriting silently loses data. The `-1` suffix and a toast lose nothing.
- **`name (1).ext`.** It needs quoting in a shell.
- **A trash folder.** Its own location, expiry and restore UI; the confirmation sheet names what goes.
- **Editing text files.** Wanted on a phone, but it brings saving over someone else's change and turns the browser into an editor. Later, if missed.
- **Rendering Markdown or HTML.** A sanitizer and an attack surface for something the text view already shows. Markdown was taken up after all in [ADR-0060](0060-files-maximize-and-markdown.md), with raw HTML off; HTML is still never rendered.
- **Downloading a folder as a zip, and tapping a path in the terminal to open it.** Both build on this. They come next, each with its own amendment.

## Consequences

- From any device you can see what's on the server, take a file with you, put one where it belongs, and hand a file that's already there to claude. On a phone it's two taps from the session button.
- The session drawer's bottom row and the `wide` tab bar each gain one button. The terminal, extra keys and text page are unchanged.
- Six new HTTP routes; a new stateless package `internal/files`. `Drawer` gains a custom header row and history handling that lets stacked sheets each close on Back.
- The threat model gains served files (§7) and writes anywhere the user can write. Both stay within what a paired device's shell can already do.
- Tests: UT-fs-path, UT-fs-name, UT-fs-list, UT-fs-save, UT-fs-ops and IT-fs-1..3 on the agent; UT-files-1..5 and UT-backstack-1 in the frontend; E2E-53.
