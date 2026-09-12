# 认证与配对

> 状态：Accepted
>
> 单用户、多设备。没有账号体系、没有密码。威胁分析见 [`threat-model.md`](threat-model.md)。

## 设计目标

1. **没有默认凭据。** 代码里不存在任何默认密码。
2. **手机上不用打字。** 扫二维码，一步完成。
3. **配对一次，长期免密。** 每台设备配对一次就够了。
4. **随时可吊销。** 手机丢了，从别的设备一键踢掉。

## 配对流程

```
服务端                                          客户端
──────────────────────────────────────────────────────────────
webterm serve
  │
  ├─ 无已授权设备？→ 生成配对码（两把钥匙，ADR-0017）
  │    code   = base64url(crypto/rand 32 字节)         ← 走二维码
  │    digits = 16 位十进制（crypto/rand，拒绝采样）    ← 手输
  │    同一行存 SHA-256(code) 与 SHA-256(digits)，TTL 5 分钟，任一把用掉整行作废
  │
  ├─ stdout 打印：
  │    https://term.example.com/pair#<code>
  │    ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄       ← ASCII 二维码
  │    █ ▄▄▄ █ ▀▄▄▀█▄ █ ▄▄▄ █
  │    …
  │    扫不了码？打开 https://term.example.com/pair 输入配对码：
  │        1234-5678-9012-3456
  │                                     手机扫码 → 打开 URL        │ 或：手机打开 /pair
  │                                          │                      │
  │  ←─── GET /pair （fragment 不发送） ─────┤ ←────────────────────┤
  │  ───→ 静态页 + JS                        │                      │
  │                                          ├─ JS 读 location.hash │ 没有 hash → 显示输入框
  │                                          ├─ history.replaceState │ 用户输入 16 位数字
  │  ←─── POST /auth/pair {code} ────────────┤ ←────────────────────┤ （空格 / - 都接受，服务端剥掉）
  │
  ├─ 限速检查（5/min/IP，超出 429）
  ├─ 规整：剥掉空格与 -；16 位纯数字 → 按数字码比，否则按 URL 码比
  ├─ 逐行常数时间比较 code_hash 与 digits_hash
  ├─ 校验：存在 / 未过期 / 未使用
  ├─ 标记 used_at
  ├─ 创建 device：id、name（从 UA 推断）、token_hash
  │
  ├─ Set-Cookie: webterm_session=<token>;
  │    HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000
  │
  │  ───→ 200 {device: {...}} ──────────────→ 跳转到主界面
```

### 为什么用 URL fragment

`#<code>` **不会发送给服务器**。所以配对码：

- 不进服务端访问日志
- 不进 `Referer` 头
- 不被中间代理记录

前端 JS 读到后立刻 `history.replaceState` 抹掉，避免留在浏览器历史里（AC-1.5）。

### 为什么打二维码

手机上手打 43 个字符的 base64 是不可接受的。扫码路径也避开了剪贴板和聊天工具（否则配对码会永久留在聊天记录里）。

用纯 Go 的二维码库渲染成半块字符（`▀▄█`）打到 stdout。终端不支持 Unicode 时回退到 `##`/`  ` 的双宽版本。

### 扫不了码：手输 16 位数字（ADR-0017）

人在手机上、终端在另一块屏幕上时扫不了码，把 URL 贴进聊天工具又正是 T2 要避免的。所以每次配对同时发一个 **16 位十进制数字码**，终端里打成 `1234-5678-9012-3456`；手机浏览器打开 `https://term.example.com/pair`（没有 fragment）就是一个数字输入框，`inputmode=numeric`、边输边按 4 位分组、满 16 位才能提交，空格与 `-` 都接受。

它和 URL 码是**同一次配对的两把钥匙**：哈希存在同一行，任一把用掉整行作废，5 分钟 TTL、常数时间比较一视同仁。约 53 位熵在既有限速下够用：一个码存活的 5 分钟里全网最多 50 次猜测（全局熔断），命中概率 5 × 10⁻¹⁵ —— 推导见 ADR-0017。**不用它替换 URL 码**：二维码那条路没理由降熵。

## 后续配对

`webterm pair` 子命令随时生成新的配对码（同样打印 URL + 二维码）。用于新设备接入。

```
$ webterm pair
配对码已生成，5 分钟内有效：

  https://term.example.com/pair#kJ8x...

  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄
  …
用手机扫码即可完成授权。

扫不了码？在手机浏览器打开  https://term.example.com/pair  输入配对码：

      4821-0937-5566-1204
```

**实现注意**：`webterm pair` 是一个独立进程，需要写入同一个 DB。SQLite 的 WAL 模式支持多进程访问，但要处理 `SQLITE_BUSY`（`busy_timeout = 5000`）。

## 设备管理（AC-1.3）

`GET /api/devices`：

```json
[
  { "id": "a3f…", "name": "iPhone · Safari", "created_at": …, "last_seen_at": …, "last_ip": "1.2.3.4", "current": true }
]
```

- `current` 标记发起请求的那台设备（防止误踢自己 —— UI 上对它二次确认）
- `name` 从 `User-Agent` 推断（`iPhone · Safari` / `macOS · Chrome`），可 `PATCH` 改名
- `DELETE /api/devices/:id` 吊销单台
- `POST /api/devices/revoke-all` 吊销全部（**包括自己**，之后需要重新配对）

`last_seen_at` / `last_ip` 更新做节流（每设备最多 60 秒写一次），避免每个请求打库。

### 吊销的即时生效（AC-1.11）

不能只在握手时检查 —— WebSocket 可能挂几天。

agent 每 **2 秒**扫一遍活跃连接，对应设备已吊销的：先发 `notice{level:"error", message:"此设备已被吊销"}`，再发 `error{code:"unauthorized"}`，然后关闭连接。

扫描周期取 2 秒而不是 5 秒，是为了给 AC-1.11 的 5 秒 SLA 留出余量 —— 周期与 SLA 取同一个值的话，最坏情况必然略微超时。

## 会话 Cookie

| 属性 | 值 | 说明 |
|---|---|---|
| 名字 | `webterm_session` | |
| 值 | base64url(32 字节 `crypto/rand`) | DB 里只存 SHA-256 |
| `HttpOnly` | ✓ | JS 读不到 |
| `Secure` | ✓（`--dev` 下省略） | |
| `SameSite` | `Strict` | 防 CSRF |
| `Path` | `/` | |
| `Max-Age` | 31536000（1 年） | |

**滑动续期**：每次请求若 Cookie 剩余有效期少于 30 天，重新 `Set-Cookie` 刷新（更新 `last_seen_at`，token 本身不轮换）。这样常用设备永不掉线。

**不做 token 轮换**：轮换需要处理"并发请求拿到旧 token"的竞态，收益（限制被盗 token 的有效期）在有即时吊销的前提下不明显。

## 限速（AC-1.6）

只对 `POST /auth/pair` 限速（其它路由要么静态、要么已认证）。

```
每 IP：5 次 / 分钟
超出 → 429 + Retry-After
连续失败 → 指数退避：1s, 2s, 4s, 8s, … 上限 5 分钟
全局：任意 IP 累计失败 50 次 / 小时 → 停止接受配对 10 分钟，并在 stdout 打告警
```

反代场景下（`--trust-proxy`）用 `X-Forwarded-For` 的最后一跳作为 IP。**默认不信任** `X-Forwarded-For`，否则攻击者可以伪造它绕过限速。

限速状态存内存（重启即清），不落库。

## 路由认证矩阵（AC-1.7）

| 路由 | 需要认证 |
|---|---|
| `GET /` `GET /assets/*` `GET /manifest.json` `GET /sw.js` | ✗ |
| `GET /pair` | ✗（页面本身；配对码在 fragment 里） |
| `POST /auth/pair` | ✗（这是配对入口，受限速保护） |
| `GET /healthz` | ✗（只返回 `ok`，不泄露任何信息） |
| `GET /.well-known/acme-challenge/*` | ✗（ACME，仅 :80） |
| **`GET /ws`** | **✓**（含 `Origin` 校验） |
| `/api/*` | ✓ |

**`/ws` 必须认证**是最容易漏的一条。中间件必须覆盖 WebSocket 升级路径，不能只包 REST。

## 静态资源为什么不认证

前端 JS/CSS 里没有秘密（所有数据都要通过认证的 API 拿）。给静态资源加认证会导致：登录页自己也需要认证的死循环，以及 Service Worker 缓存的复杂化。

未认证用户访问 `/` 时，前端 JS 调 `/api/devices` 拿到 401，展示"需要配对"的引导页（告诉用户在服务器上跑 `webterm pair`）。

## `--dev` 模式

**不做任何认证旁路。** 保持单一代码路径（旁路是安全 bug 的经典来源）。

`--dev` 下的差异只有：
- Cookie 不带 `Secure`
- 允许 `Origin` 为 `http://localhost:*` / `http://127.0.0.1:*`
- 不申请证书，不发 HSTS

配对流程完全一样 —— 启动时打印 `http://127.0.0.1:8080/pair#...`，本地点开即可。

## v0.2：Passkey / WebAuthn

配对码解决了"首次授权"，Cookie 解决了"长期免密"。剩下的缺口是**新设备接入需要访问服务器终端**。

Passkey 会填上这个缺口：配对一台设备后注册 passkey，之后任何新设备都能用 Face ID / 指纹直接登录，不需要 SSH 上服务器。

不在 v0.1，因为当前流程已经可用，且 Passkey 涉及一套独立的注册/断言流程与 credential 存储。
