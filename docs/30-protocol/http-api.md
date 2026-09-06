# HTTP API

> 状态：Accepted
>
> ★ 前后端契约的第二半（第一半是 [`websocket-protocol.md`](websocket-protocol.md)）。终端流走 WebSocket，其余都走这里。

## 通则

- 所有 `/api/*` 要求有效设备 Cookie，无效返回 `401`（[`../60-security/auth-pairing.md`](../60-security/auth-pairing.md#路由认证矩阵ac-17)）
- 请求与响应都是 JSON（`Content-Type: application/json`）
- 写操作只用 `POST` / `PATCH` / `DELETE`。**不需要 CSRF token** —— Cookie 是 `SameSite=Strict`，跨站请求根本带不上凭据
- 错误统一为 `{"code": "...", "message": "..."}`，`code` 复用 [WebSocket 协议 §7](websocket-protocol.md#7-错误码) 的取值，加上 HTTP 层的 `not_found`
- 时间戳一律 unix 毫秒整数

## 配对与设备

见 [`../60-security/auth-pairing.md`](../60-security/auth-pairing.md)：`POST /auth/pair`、`GET /api/devices`、`PATCH /api/devices/:id`、`DELETE /api/devices/:id`、`POST /api/devices/revoke-all`。

## 命令历史与快捷命令

数据模型见 [`../50-backend/storage-schema.md`](../50-backend/storage-schema.md#commands)，交互见 [`../40-frontend/commands-ux.md`](../40-frontend/commands-ux.md)。
**快捷命令不是独立资源**，就是 `pinned = true` 的命令记录（[ADR-0008](../20-architecture/adr/0008-pinned-history-as-snippets.md)）—— 所以只有这一组端点。

### `GET /api/commands`

| 查询参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | 命令原文子串匹配（v0.1 用 `LIKE`，不是 FTS） |
| `cwd` | — | 精确匹配执行目录 |
| `failed` | `false` | 只看 `exit_code != 0`（不含未完成的） |
| `pinned` | — | `true` 只看快捷命令，按 `pin_order` 升序；否则按 `started_at` 倒序 |
| `limit` | 50 | 上限 200 |
| `before` | — | 游标：上一页最后一条的 `started_at`。**用游标不用 offset** —— 历史一直在追加，offset 分页会漏行和重行 |

```json
{ "items": [ { "id": 8842, "text": "go test ./...", "cwd": "/srv/x", "session_name": "api",
               "exit_code": 0, "started_at": 1757116800000, "duration_ms": 4210,
               "pinned": true, "label": "跑测试", "pin_order": 2 } ],
  "next_before": 1757116700000 }
```

`exit_code` / `duration_ms` 为 `null` 表示未完成（shell 在 `133;D` 之前死了，或这是一条手动新建的快捷命令）。`next_before` 为 `null` 表示没有下一页。

### `POST /api/commands`

手动新建一条从未执行过的快捷命令（次要入口，不在主路径上）。

```json
请求  { "text": "systemctl --user restart api", "label": "重启服务" }
响应  201 + 完整记录（pinned = true，exit_code / duration_ms 为 null）
```

### `PATCH /api/commands/:id`

```json
{ "pinned": true, "label": "重启服务", "pin_order": 3 }
```

三个字段都可选，只改传了的那些。拖动排序时把受影响的项**一次批量提交**（`PATCH /api/commands` + `{"items":[{"id":…,"pin_order":…}]}`），避免中间态出现重复的 `pin_order`。

### `DELETE /api/commands/:id`

删除单条。UI 侧的 3 秒撤销是客户端行为（延迟发请求），服务端没有回收站。

### `DELETE /api/commands?pinned=false`

清空全部**非置顶**历史，返回 `{"deleted": 12043, "kept_pinned": 7}`。

**必须带 `pinned=false`** —— 不带参数的整表删除不提供，因为置顶记录承载着快捷命令，误删不可恢复（AC-6.10 的同一条理由）。

## 设置

```json
GET   /api/settings          → { "history_enabled": true }
PATCH /api/settings          → 同上，只改传了的字段
```

`history_enabled` 对应 [`../60-security/privacy-history.md`](../60-security/privacy-history.md#用户的控制手段ac-69) 的"完全关闭历史记录"。关闭后不写 `commands` 表，但 OSC 133 照常解析 —— **输入模式自动切换不依赖命令原文**，不受影响。

命令行 `--no-history` 是这个开关的启动态覆盖：给了它就锁死为关闭，UI 上置灰。

## 健康检查

`GET /healthz` → `200 ok`。不认证、不泄露任何信息（连版本号都不给）。
