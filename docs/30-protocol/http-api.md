# HTTP API

> Status: Accepted
>
> ★ The second half of the frontend–backend contract (the first is [`websocket-protocol.md`](websocket-protocol.md)). The terminal stream uses the WebSocket; HTTP covers only pairing, device management and the health check.

## General rules

- Every `/api/*` route requires a valid device cookie and returns `401` without one ([`../60-security/auth-pairing.md`](../60-security/auth-pairing.md#route-authentication-matrix-ac-17))
- Requests and responses are JSON (`Content-Type: application/json`)
- Writes use only `POST` / `PATCH` / `DELETE`. **No CSRF token is needed** — the cookie is `SameSite=Strict`, so cross-site requests never carry credentials
- Errors are always `{"code": "...", "message": "..."}`; `code` reuses the values from [WebSocket protocol §7](websocket-protocol.md#7-error-codes), plus the HTTP-only `not_found`. Unknown or removed `/api/*` paths **authenticate first** (401 if unauthenticated), then return 404 `not_found` — they must not fall through to the frontend's page fallback route
- Timestamps are always integer unix milliseconds

## Pairing and devices

See [`../60-security/auth-pairing.md`](../60-security/auth-pairing.md): `POST /auth/pair`, `POST /auth/logout`, `GET /api/devices`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id`, `POST /api/devices/revoke-all`.

## Health check

`GET /healthz` → `200 ok`. No authentication, and it discloses nothing (not even the version).
