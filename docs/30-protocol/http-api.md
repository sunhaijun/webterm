# HTTP API

> Status: Accepted
>
> ★ The second half of the frontend–backend contract (the first is [`websocket-protocol.md`](websocket-protocol.md)). The terminal stream uses the WebSocket; HTTP covers pairing, device management, uploads, frequent input and the health check.

## General rules

- Every `/api/*` route requires a valid device cookie and returns `401` without one ([`../60-security/auth-pairing.md`](../60-security/auth-pairing.md#route-authentication-matrix-ac-17))
- Requests and responses are JSON (`Content-Type: application/json`). The one exception is the request body of `POST /api/uploads`, which is the file itself
- Writes use only `POST` / `PATCH` / `DELETE`. **No CSRF token is needed** — the cookie is `SameSite=Strict`, so cross-site requests never carry credentials
- Errors are always `{"code": "...", "message": "..."}`; `code` reuses the values from [WebSocket protocol §7](websocket-protocol.md#7-error-codes), plus the HTTP-only `not_found` and `too_large`. Unknown or removed `/api/*` paths **authenticate first** (401 if unauthenticated), then return 404 `not_found` — they must not fall through to the frontend's page fallback route
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

## Frequent input

The ten single-line inputs sent most often to a program, from that program's own history file ([ADR-0054](../20-architecture/adr/0054-frequent-input-and-combo-keys.md) §3). Authenticated. Read on request; the agent keeps no copy and logs no entry.

```
GET /api/frequent?program=claude

200 {"items": ["/clear", "继续", "/compact"]}
```

| `program` | Source |
|---|---|
| `claude` | `~/.claude/history.jsonl`, field `display` |
| `codex` | `~/.codex/history.jsonl`, field `text` |
| `shell` | the session shell's history: `~/.bash_history` (bash; `#<digits>` timestamp lines skipped) or `~/.zsh_history` (zsh; `: <time>:<n>;` prefix removed) |
| anything else | `{"items": []}` |

- At most the last 1 MiB of the file and its last 1000 entries are read. Entries are trimmed; only single-line ones of 1–80 characters are kept; claude's placeholders (`[Pasted text #N …]`, `[Image #N]`) are dropped; for `shell`, so are entries shorter than 3 characters.
- Ranked by count, ties by the most recent; at most 10.
- A missing or unreadable file is an empty list, not an error.

## Health check

`GET /healthz` → `200 ok`. No authentication, and it discloses nothing (not even the version).
