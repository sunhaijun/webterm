# HTTP API

> 状态：Accepted
>
> ★ 前后端契约的第二半（第一半是 [`websocket-protocol.md`](websocket-protocol.md)）。终端流走 WebSocket；HTTP 只剩配对、设备管理与健康检查。

## 通则

- 所有 `/api/*` 要求有效设备 Cookie，无效返回 `401`（[`../60-security/auth-pairing.md`](../60-security/auth-pairing.md#路由认证矩阵ac-17)）
- 请求与响应都是 JSON（`Content-Type: application/json`）
- 写操作只用 `POST` / `PATCH` / `DELETE`。**不需要 CSRF token** —— Cookie 是 `SameSite=Strict`，跨站请求根本带不上凭据
- 错误统一为 `{"code": "...", "message": "..."}`，`code` 复用 [WebSocket 协议 §7](websocket-protocol.md#7-错误码) 的取值，加上 HTTP 层的 `not_found`。未知或已删除的 `/api/*` 路径**先认证**（未认证 401），再回 404 `not_found` —— 不能落进前端页面的回退路由
- 时间戳一律 unix 毫秒整数

## 配对与设备

见 [`../60-security/auth-pairing.md`](../60-security/auth-pairing.md)：`POST /auth/pair`、`GET /api/devices`、`PATCH /api/devices/:id`、`DELETE /api/devices/:id`、`POST /api/devices/revoke-all`。

## 健康检查

`GET /healthz` → `200 ok`。不认证、不泄露任何信息（连版本号都不给）。
