# HTTP API

> Status: Accepted
>
> ★ The second half of the frontend–backend contract (the first is [`websocket-protocol.md`](websocket-protocol.md)). The terminal stream uses the WebSocket; HTTP covers pairing, device management, uploads, files, the command strip and the health check.

## General rules

- Every `/api/*` route requires a valid device cookie and returns `401` without one ([`../60-security/auth-pairing.md`](../60-security/auth-pairing.md#route-authentication-matrix-ac-17))
- Requests and responses are JSON (`Content-Type: application/json`). The exceptions are the request bodies of `POST /api/uploads` and `POST /api/fs/upload`, which are the file itself, and the response of `GET /api/fs/raw`, which is the file
- Writes use only `POST` / `PATCH` / `DELETE`. **No CSRF token is needed** — the cookie is `SameSite=Strict`, so cross-site requests never carry credentials
- Errors are always `{"code": "...", "message": "..."}`; `code` reuses the values from [WebSocket protocol §7](websocket-protocol.md#7-error-codes), plus the HTTP-only `not_found`, `too_large`, `forbidden` (the agent user may not do that) and `exists` (the name is taken). Unknown or removed `/api/*` paths **authenticate first** (401 if unauthenticated), then return 404 `not_found` — they must not fall through to the frontend's page fallback route
- Timestamps are always integer unix milliseconds

## Pairing and devices

See [`../60-security/auth-pairing.md`](../60-security/auth-pairing.md): `POST /auth/pair`, `POST /auth/logout`, `GET /api/devices`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id`, `POST /api/devices/revoke-all`.

## Uploads

Sends a file to a session ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)): the agent saves it and returns its absolute path, which the frontend then pastes into the session. Authenticated, with the `Origin` check.

```
POST /api/uploads?name=Screenshot%202026-11-06.png
Content-Type: image/png            (informational; not used)
<the file's bytes>

201 {"path": "/tmp/webterm-1000/uploads/Screenshot-2026-11-06-a1b2c3.png", "size": 48213}
```

| Case | Reply |
|---|---|
| Saved | `201` with `path` (absolute) and `size` (bytes) |
| Empty body | `400 bad_request` |
| Body over 20 MiB | `413 too_large`; nothing is kept |
| The upload directory isn't usable (not a directory, a symlink, another owner, open to group or others), or the write failed | `500 internal`; the reason goes to the log |

- `name` is optional and only shapes the saved name: `<stem>-<6 hex>.<ext>`. The stem keeps letters (any script), digits, `.` and `_`, turns every other run of characters (including `-` itself) into one `-`, is trimmed of leading and trailing `-._`, cut to 60 bytes, and is `file` if nothing is left. The extension is the original one in lowercase when it is 1–8 letters or digits, otherwise sniffed from the content (`png` `jpg` `gif` `webp` `pdf` `txt`), otherwise none. The saved path never needs quoting in a shell.
- The body is streamed to disk, not buffered in memory.
- There is no route to list, read or delete uploads.

## Files

The file browser ([ADR-0059](../20-architecture/adr/0059-files.md)). Every route is authenticated; the writes (`POST`, `DELETE`) also need the `Origin` check. Paths are absolute: a path that doesn't start with `/` or contains a NUL byte is `400 bad_request`. Paths are cleaned (`/a/./b/../c` → `/a/c`) and symbolic links are followed. The agent user's permissions are the only limit.

Errors common to every route:

| Case | Reply |
|---|---|
| The path (or the folder, for `upload`) doesn't exist | `404 not_found` |
| The agent user lacks permission | `403 forbidden` |
| The name is taken (`mkdir`, `rename`) | `409 exists` |
| Anything else that fails on disk (full disk, I/O error) | `500 internal`; the reason goes to the log, without the path |

### List a folder

```
GET /api/fs/list?path=/home/u/proj

200 {"path": "/home/u/proj",
     "entries": [
       {"name": "src", "type": "dir", "size": 0, "mtime": 1762581600000},
       {"name": "README.md", "type": "file", "size": 4213, "mtime": 1762588000000},
       {"name": "dev-null-link", "type": "other", "size": 0, "mtime": 1762500000000},
       {"name": "\ufffd\ufffd.txt", "type": "file", "size": 3, "mtime": 1762500000000, "bad_name": true}
     ],
     "total": 3}
```

- `path` is the cleaned path. `entries` are in byte order of their names (the page sorts them for display), at most **5,000**; `total` counts all of them.
- `type` is that of the link's target for a symbolic link: `dir`, `file` (a regular file) or `other` (a device, FIFO, socket, or a link that points nowhere). `size` is in bytes and `0` except for files; `mtime` is unix milliseconds.
- `bad_name: true`: the name isn't valid UTF-8, so JSON carries it with U+FFFD in place of the bad bytes. Requests can't address that entry; the page shows it inert.
- `path` not a folder → `400 bad_request`.

### Read a file

```
GET /api/fs/raw?path=/home/u/proj/shot.png            (&download=1 for a download)

200 / 206 the bytes
Content-Type: image/png
Content-Disposition: inline; filename="shot.png"      (attachment unless inline is allowed, below)
Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox
Cache-Control: no-store
ETag: "<size hex>-<mtime ns hex>"
```

- **Only regular files.** A folder, device, FIFO or socket is `400 bad_request`, refused before it is opened; opening never blocks.
- `http.ServeContent` semantics: `Range` (one range or a suffix like `bytes=-524288`) gives `206`, `If-None-Match` / `If-Modified-Since` give `304`, `HEAD` works. `no-store` keeps viewed files out of the browser's disk cache, so a browser won't revalidate; `ETag` still lets a resumed download check the file didn't change.
- `Content-Type` comes from the extension (lowercased): `png` `jpg`/`jpeg` `gif` `webp` `avif` `bmp` `ico` `svg` → the image types; `mp4`/`m4v` `webm` `mov` `ogv` → video; `mp3` `m4a` `aac` `wav` `flac` `ogg`/`oga`/`opus` → audio; `pdf` → `application/pdf`; `txt` `log` `md` `csv` → `text/plain; charset=utf-8`; anything else `application/octet-stream`.
- `Content-Disposition` is `inline` only for image types other than SVG, video and audio, and only without `download=1`; everything else is `attachment`. The filename uses RFC 5987 encoding (`filename*=utf-8''…`) when it isn't plain ASCII.

### Upload into a folder

```
POST /api/fs/upload?dir=/home/u/proj&name=shot%201.png
<the file's bytes>

201 {"path": "/home/u/proj/shot 1-1.png", "name": "shot 1-1.png", "size": 48213}
```

- `name` is the file's name, kept as is. It must be one path component: not empty, not `.` or `..`, no `/`, no control characters, at most 255 bytes; otherwise `400 bad_request`.
- **Never overwrites.** If `name` is taken, the file is saved as `<stem>-1<ext>`, then `-2`, … up to `-999` (`<ext>` is the last extension; a name starting with `.` and no other dot has none). The response names the file actually written.
- The body streams to a hidden `.webterm-upload-<12 hex>.part` in `dir`, created exclusively with mode `0666` minus the umask, then is renamed into place without replacing anything. A read error (the client went away) deletes it and returns `400 bad_request`. There is no size limit; a full disk is `500 internal` and leaves nothing.
- `dir` not a folder → `400 bad_request`.

### New folder, rename, delete

```
POST /api/fs/mkdir  {"dir": "/home/u/proj", "name": "new"}  → 201 {"path": "/home/u/proj/new"}
POST /api/fs/rename {"path": "/home/u/proj/a.txt", "name": "b.txt"} → 200 {"path": "/home/u/proj/b.txt"}
DELETE /api/fs?path=/home/u/proj/old                       → 204
```

- `mkdir` creates the folder `name` in `dir` (mode `0777` minus the umask); `name` follows the rules above.
- `rename` renames within the same folder; `name` follows the rules above. It never replaces: a taken name is `409 exists`. The same name is `200` and changes nothing. Renaming `/` or the home directory is `400 bad_request`, as for `DELETE`.
- `DELETE` removes a file, a symbolic link (not its target) or a folder with everything in it. It refuses `/` and the agent user's home directory with `400 bad_request`, also when the path reaches them another way (a symlinked parent); a link to either is just a link and is deleted.
- Bodies are JSON, at most 64 KiB.

## Commands

The command strip's items for the program in front of a session, merged with your arrangement (ADR-0057 §4–§5). Authenticated; `PUT` and `DELETE` need the `Origin` check.

```
GET /api/commands?sid=3            (&refresh=1 asks the tool again)

200 {"program": "claude",
     "items": [
       {"id": "key:shift-tab", "label": "⇧Tab Mode", "kind": "keys", "send": ["\u001b[Z"], "enter": false, "origin": "key", "hidden": false},
       {"id": "/compact", "label": "/compact", "kind": "text", "send": ["/compact"], "enter": true, "origin": "builtin", "hidden": false},
       {"id": "/deep-research", "label": "/deep-research", "kind": "text", "send": ["/deep-research"], "enter": true, "origin": "skill", "hidden": true}
     ],
     "arrangement": {"order": ["key:shift-tab", "/compact"]},
     "warning": ""}
```

| Case | Reply |
|---|---|
| The session's program is `claude` or `codex` | `200` with the items in order; `warning` says why built-ins are missing if the claude probe failed |
| Any other program | `200 {"program": "<it>", "items": []}` |
| Unknown sid | `404 not_found` |

```
PUT /api/commands?program=claude
{"order": ["/compact", "key:shift-tab"], "visible": {"/deep-research": true}, "edits": {"/compact": {"label": "compact", "enter": true}}, "added": [{"id": "add:1", "label": "继续", "send": "继续", "enter": true}]}

204

DELETE /api/commands?program=claude      → 204, back to the defaults
```

- `kind: "keys"`: `send` is a list of byte strings written 120 ms apart; `kind: "text"`: `send` has one string, followed by Enter when `enter` is true.
- `origin`: `key`, `builtin`, `custom`, `skill` (hidden by default), `added`.
- `arrangement` is the stored arrangement as `PUT` takes it; the editor changes it and sends it back whole.
- The arrangement is saved to `~/.config/webterm/commands.json` (0600, atomic). Bodies over 256 KiB, more than 1000 entries, or another program than `claude` / `codex` get `400 bad_request`.

## Health check

`GET /healthz` → `200 ok`. No authentication, and it discloses nothing (not even the version).
