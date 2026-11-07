# ADR-0051 Send files to a session

Status: Accepted (2026-11-06). Adds `POST /api/uploads` to the [HTTP API](../../30-protocol/http-api.md#uploads) and amends invariant 3: files the user sends go to the system temp directory and are deleted after a day. The WebSocket protocol is unchanged.

## Context

The main use of webterm is driving claude and codex from a phone ([ADR-0012](0012-ai-cli-conversation-first.md)). Both take images: a screenshot of an error, a photo of a whiteboard, a design mock. In a local terminal there are two ways in. `Ctrl+V` makes the program read the system clipboard, and dragging a file onto the terminal makes the terminal type the file's path.

Neither works through a browser. The program runs on the server, so its `Ctrl+V` reads the server's clipboard (`xclip` / `wl-paste`), which is empty. The file is on the phone, so there is no path to type.

Measured on the server with a real PTY (claude 2.1.317, codex 0.166.0, 2026-11-06), using a bracketed paste and no Enter:

| Pasted | claude | codex |
|---|---|---|
| One absolute path to an image | `[Image #1]` | `[Image #1]` |
| The same, from a PTY through a tmux client to a tmux pane | `[Image #1]` | — |
| Two paths in one paste | `[Image #1] [Image #2]` | plain text |
| Two pastes of one path each | — | `[Image #1] [Image #2]` |
| A path inside a sentence | plain text | plain text |
| A path without an image extension | plain text | — |

The extension decides, in any case (`.JPG` works), and non-ASCII names work (`截图-1.png`). A path pasted as plain text still reaches the model as text, so it can read the file with a tool. It just isn't attached.

## Decision

### 1. Upload, then paste the path

The browser uploads the file to the agent. The agent saves it under the system temp directory and returns its absolute path. The browser then pastes **that path alone** into the session, **one paste per file**, with no Enter. This is what dragging a file onto a local terminal does, so it means the same thing to every program. claude and codex turn the paste into an attachment, and a shell gets a path at the cursor.

The path doesn't go into the text page's draft. A path inside a sentence stays plain text (table above), so the file is pasted into the terminal right away and the draft is left alone. Pressing Enter on the text page then submits the draft with the attachment in front of it: `[Image #1] what is wrong here?`.

### 2. Where files come from

| | Phone | Tablet | Desktop |
|---|---|---|---|
| Paperclip button → system picker (photo library, camera, files) | text page | text page, tab bar | tab bar |
| Paste a clipboard that holds files and no text | text box | text box, terminal | terminal (`Ctrl+Shift+V` / `Cmd+V`) |
| Drop files anywhere on the page | — | yes | yes |

- **The paperclip button** sits on the text page, right of the text box, in a 44px column like the left one ([layout.md](../../40-frontend/layout.md#geometry)), and on the `wide` tab bar, left of the connection dot. It is a line icon in the same style as the others ([ADR-0037](0037-settings-theme-and-font-size.md) §3). It is 22×22 with a 2px stroke on the text page, like ✎, and 14×14 with a 1.75px stroke on the tab bar, like `+` and ⚙. It is not a `+`, because `+` on the tab bar already means New session. The keys page doesn't change: its 14 keys stay as they are.
- **One file input** (`<input type="file" multiple>`, no `accept` filter) serves both buttons. Clicking a button opens it from inside the click, which iOS requires.
- **Paste**: a capture-phase listener over the terminal and the text box. A clipboard with files and an empty `text/plain` is sent as files; the event is stopped so xterm doesn't also paste nothing. Anything with text is an ordinary paste, as before. That includes "Copy image" from a web page that also put text on the clipboard.
- **Drop**: `dragover` and `drop` on the window, only when the drag carries files. Without this a file dropped on the page makes the browser open the file in place of webterm. While files are dragged over the page, the terminal area gets an accent outline.
- **Which session**: the one that was current when the file was chosen, pasted, or dropped. The upload can take seconds on a phone; switching sessions meanwhile doesn't redirect it.
- **Several files** upload one at a time, in the order given, and each is pasted as soon as it's saved.
- **Feedback**: while uploads are in flight, both paperclip buttons have `data-busy="true"` (accent color, pulsing like the reconnecting dot). On success there is nothing else: the program's `[Image #N]`, or the path at a shell prompt, is the confirmation. On failure a toast says why and nothing is pasted: the file is too large, the upload failed, or the session ended meanwhile.
- **No client-side processing.** Files go up as they are. Whether iOS hands over HEIC photos as JPEG, and whether a full-size phone photo is accepted by the programs, are in the manual checklist. Resizing or converting in the browser is the fallback if either fails.

### 3. The paste is user input

The path goes in through `term.paste()`, like the text page's text. It is bracketed if the program enabled bracketed paste, goes through `onData`, is counted in `inputStats` and is resent after a reconnect. It claims the session's size like any user input ([ADR-0050](0050-ssh-attach.md) §5), and sticky CTRL / ALT don't apply to it.

It isn't produced inside a DOM input event, though: the upload finishes later. If that happens while the session is replaying, the replay gate would treat the paste as an automatic reply and drop it silently, which [ADR-0020](0020-input-never-silently-dropped.md) forbids. So the paste runs inside `asUserInput()`, which marks a user action completed outside an event dispatch. The gate's test becomes "a user input event is being dispatched, **or** code marked as user input is running" ([input.md](../../40-frontend/input.md#the-replay-gate-ac-215-adr-0020)).

### 4. `POST /api/uploads`

- **The body is the file**, not multipart and not JSON. The original name goes in the query, `?name=<URL-encoded>`, and is used only to build the saved name. The response is `201 {"path": "/tmp/webterm-1000/uploads/shot-a1b2c3.png", "size": 48213}`.
- The route is authenticated and checks `Origin` like the other writes ([auth-pairing.md](../../60-security/auth-pairing.md#route-authentication-matrix-ac-17)).
- **HTTP, not the WebSocket.** One WebSocket carries every session, and a multi-megabyte upload on it would hold up every session's output until it finished (CLAUDE.md, connection layer). A separate request travels in parallel, on the same HTTP/2 connection in production.
- **Limits**: 20 MiB per file (`413 too_large`). An empty body is `400 bad_request`. The body streams to a temporary `.part` file and is renamed into place when complete, so the agent's memory use doesn't grow with the file size. A rejected or interrupted upload leaves nothing behind.

### 5. Storage and cleanup

- **Directory**: `<temp>/webterm-<uid>/uploads/`, where `<temp>` is `$TMPDIR`, or `/tmp` when it isn't set. This follows tmux's `/tmp/tmux-<uid>`. `webterm-<uid>` is created `0700`. Before every upload the agent checks that it is a real directory (not a symlink), owned by the agent's uid, and closed to group and others. If not, another local user got there first, and uploads are refused with `500 internal` and a log line. The agent never uses or repairs a directory it doesn't own.
- **Files** are created with `O_EXCL | O_NOFOLLOW`, mode `0600`.
- **Names**: `<stem>-<6 hex>.<ext>`.
  - The stem is the original name without its extension. Letters (any script), digits, `.`, `_` and `-` are kept, and every other run of characters becomes one `-`. Leading and trailing `-` `.` `_` are trimmed, the stem is cut to 60 bytes, and an empty result becomes `file`.
  - The extension is the original one, lowercased, if it is 1–8 letters or digits. Otherwise it comes from the content (`png`, `jpg`, `gif`, `webp`, `pdf`, `txt`), or there is none.
  - So a path never needs quoting in a shell, and a screenshot without a name still gets the extension claude needs.
- **Cleanup**:
  - Files older than **24 hours** (by modification time) are deleted at startup and every hour.
  - After each upload, if the directory holds more than **256 MiB**, the oldest files are deleted until it fits.
  - Leftover `.part` files are deleted by the same sweep.
- **What doesn't delete files.** Closing a session, the agent exiting and a hot upgrade all leave files alone:
  - A program may still need the file after its session closes. tmux's server leaves the session, so claude or codex in a tmux pane keeps running after the webterm session closes. codex reads the image when the prompt is submitted, not when it's pasted.
  - The files are plain files, so they need no handoff ([ADR-0016](0016-hot-reexec.md)).
- **Invariant 3** now reads: terminal output never touches disk; devices and authentication data are kept in the data directory; files the user sends live in the temp directory until the sweep deletes them. On systems where `/tmp` is a tmpfs (Debian 13's default for new installs) they never reach disk at all.
- **Nothing is served back.** There is no download or listing route, so an uploaded HTML or SVG file can't become a page on webterm's origin. Logs don't contain file names, only sizes at debug level.

## Alternatives considered

- **Make the program's `Ctrl+V` work**, with a fake `xclip` / `wl-paste` on the session's `PATH` that hands over the last uploaded image. It depends on how each program reads the clipboard and on `DISPLAY` / `WAYLAND_DISPLAY` checks. It also misses programs in tmux, whose environment comes from the tmux server, not the session.
- **Upload over the WebSocket** as a new frame type. It would stall every session's output during the transfer (§4), and it means a protocol version bump.
- **Save into the session's working directory.** That pollutes repositories, and under tmux the session's directory isn't the pane's.
- **A persistent directory** (`~/webterm-uploads`, the data directory). These are attachments for a conversation, not files to keep. Copying a file somewhere permanent is one `cp` away, and a permanent directory needs its own cleanup policy or grows forever.
- **The agent types the path into the PTY itself** (`POST /api/sessions/:sid/paste`). It would bypass the client's input accounting (resend, `inputStats`, the size claim), and the agent would have to know whether bracketed paste is on.
- **The path in the text page's draft.** It reaches the program as part of a sentence, which neither claude nor codex turns into an attachment (§Context).
- **Resize images in the browser.** The model sees a downscaled image anyway, but it is extra code for a problem not yet seen. It stays the fallback (§2).
- **Android's share sheet** (Web Share Target). It is useful, but Android-only and needs service-worker code of its own. It's a separate step.

## Consequences

- On any device, a screenshot or photo reaches claude or codex as an attachment, in the session you pick it from. The phone can feed a session you drive from a laptop, including over `webterm attach` ([ADR-0050](0050-ssh-attach.md)).
- The text page and the `wide` tab bar each gain one button. The keys page is unchanged.
- A new HTTP route with a non-JSON body. The WebSocket protocol and the handoff snapshot don't change.
- Uploaded files can sit on disk for up to a day, readable only by the agent's user. On a disk-backed `/tmp` that is the one exception to "only devices and auth data on disk".
- Tests: UT-upload-name, UT-upload-dir, UT-upload-sweep and IT-upload-1 on the agent; UT-upload-1..3 in the frontend; E2E-48 for the picker, paste and drop.
