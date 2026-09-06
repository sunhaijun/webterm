# 威胁模型

> 状态：Accepted

## 我们在保护什么

webterm 把一台服务器的 shell 暴露到公网。**攻破 webterm = 拿到该用户在该机器上的全部权限**（以及 sudo 可达的一切）。

这是这个项目最高的风险项。所以安全设计必须在功能之前定义，而不是事后补。

## 资产

| 资产 | 后果 |
|---|---|
| shell 访问权 | 完全沦陷：读写文件、启动进程、横向移动 |
| 会话 Cookie | 等价于 shell 访问权 |
| 配对码（未使用、未过期） | 等价于 shell 访问权 |
| 命令历史 | 泄露工作内容、路径结构、有时含误贴的凭据 |
| 终端输出 | 可能含密钥、token、日志中的敏感数据（**因此不落盘**） |
| TLS 私钥 | 中间人攻击 |

## 信任边界

```
        不可信                    │           可信
                                  │
  互联网上的任意请求               │  已配对设备的浏览器
  未认证的 WebSocket 握手          │  agent 进程
  Origin 不匹配的请求              │  运行 agent 的用户账号
                                  │
  ─────────── 认证前置 ───────────┤
                                  │
  同机的其它用户（部分不可信）      │
```

**明确不在信任边界内**：
- 同机的其它本地用户 → 因此 db `0600`、rcfile `0600`、不用 `/tmp`、不绑定 `0.0.0.0` 时的本地端口不做额外保护假设
- 浏览器扩展 → 无法防御，超出范围

**明确在信任边界内**：
- 运行 agent 的用户账号本身。agent 不试图沙箱化自己的 shell —— 那是自欺欺人（用户本来就有这台机器的 shell）

## 威胁与缓解

### T1 未授权访问（最高风险）

**攻击面**：443 端口对整个互联网开放。

| 缓解 | 实现 |
|---|---|
| 认证前置于一切 | 除 `/pair`、静态资源、`/healthz` 外全部要求有效 Cookie，**包括 WebSocket 升级**（AC-1.7） |
| 无默认凭据 | 配对码每次随机生成。**代码里不存在任何默认密码** |
| 配对码高熵 | 32 字节 `crypto/rand`，base64url。暴力枚举不可行 |
| 配对码短命且一次性 | 5 分钟 TTL，用过即废（AC-1.4） |
| 限速与退避 | 5 次/分钟/IP，之后指数退避返回 429（AC-1.6） |
| 常数时间比较 | `subtle.ConstantTimeCompare`，防时序侧信道 |
| 攻击面极小 | 未认证可达的路由只有：静态资源、`POST /auth/pair`、`GET /healthz`。没有其它动态入口 |
| 可选内网绑定 | `--bind 127.0.0.1` 让用户可以只通过 SSH 隧道访问 |

**残余风险**：暴露 443 本身。这是放弃 Cloudflare Tunnel 的代价（[ADR-0002](../20-architecture/adr/0002-self-contained-binary.md)）。已接受，缓解手段是上面这些 + 用户可选择自己套隧道。

### T2 配对码泄露

**攻击场景**：配对码出现在日志、浏览器历史、Referer 头、聊天记录里。

| 缓解 | 实现 |
|---|---|
| 用 URL **fragment** 传递 | `https://x/pair#<code>`。fragment 不发给服务器，**不进访问日志、不进 Referer**（AC-1.5）。前端 JS 读取后 `POST` 提交 |
| 提交后立即清除 fragment | `history.replaceState` 抹掉，防止浏览器历史留存 |
| 一次性 + 5 分钟 TTL | 即便泄露，窗口极小 |
| 不记录到任何日志 | 日志里对配对码做脱敏（AC-8.5） |
| 二维码传递 | 扫码路径不经过剪贴板/聊天工具 |

### T3 会话 Cookie 被盗

| 缓解 | 实现 |
|---|---|
| `HttpOnly` | JS 读不到，XSS 偷不走（AC-1.9） |
| `Secure` | 只走 HTTPS（`--dev` 例外） |
| `SameSite=Strict` | 防 CSRF，跨站请求不带 Cookie |
| 只存哈希 | DB 泄露拿不到可用 Cookie（AC-1.10） |
| 可吊销 | 设备列表里单独吊销 / 一键全部吊销（AC-1.3） |
| 吊销即时生效 | 已建立的 WebSocket 在 5 秒内被断开（AC-1.11） |

**吊销的即时性**：agent 每 5 秒检查活跃连接对应的设备是否已吊销，是则发 `notice` + `error{unauthorized}` 并关闭。不能只在握手时检查 —— 长连接可能挂几天。

### T4 CSRF / 跨站攻击

| 缓解 | 实现 |
|---|---|
| `SameSite=Strict` Cookie | 跨站请求不带凭据 |
| WebSocket `Origin` 校验 | 严格等于配置域名，不匹配返回 403（AC-1.8） |
| 所有变更操作用非 GET | REST 的写操作只走 `POST`/`PATCH`/`DELETE` |

**为什么 WebSocket 要单独校验 `Origin`**：WebSocket 握手**不受 CORS 保护**。虽然现代浏览器对 `SameSite=Strict` Cookie 在 WS 握手时也不发送，但这个行为历史上有过差异。Origin 校验是必需的第二道防线。

### T5 XSS

**攻击场景**：终端输出里的内容被当成 HTML 渲染。

| 缓解 | 实现 |
|---|---|
| xterm.js 渲染到 canvas/WebGL | 终端内容**根本不进 DOM**，不存在注入面 |
| 不启用 `linkHandler` 的自动 HTML | 超链接（OSC 8）只允许 `http`/`https` 协议，其它一律不可点 |
| 会话名/CWD 等元数据 | 通过 `textContent` 设置，绝不用 `innerHTML` |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://<domain>; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |

命令历史面板会以文本形式展示命令原文 —— 必须用 `textContent`。这是唯一一处"服务端数据进 DOM"的地方，需要在 review 时特别注意。

### T6 拒绝服务

| 威胁 | 缓解 |
|---|---|
| 大量未认证连接 | 认证前的处理极轻（查 Cookie 哈希）；配对限速 |
| 会话耗尽内存 | 会话数上限 20，每会话缓冲 1 MiB → 上界 20 MiB |
| 连接耗尽内存 | 并发连接上限 16（`--max-conns`），每连接写队列 4 MiB → 上界 64 MiB。**必须有这个上限** —— 协议允许同设备开任意多标签页 |
| 慢客户端拖死会话 | 连接写队列有界（4 MiB），满则**断开该连接**而不是阻塞 PTY（[协议 §5.5](../30-protocol/websocket-protocol.md#55-有界队列策略读写两侧)） |
| 卡住的 shell 拖死整条连接 | 会话输入队列有界（256 KiB），满则回 `input_stalled` 并**断开该连接**，绝不阻塞连接读循环（同上） |
| 巨帧内存放大 | 单帧上限 256 KiB，超出即断开 |
| OSC 负载放大 | OSC 负载上限 8 KiB，超限原样吐出 |
| 输入队列膨胀 | client 侧 `pending` 上限 64 KiB |
| 历史表膨胀 | 5 万条上限 + 定期淘汰 |

**注意**：失去了 Cloudflare 的 DDoS 防护（[ADR-0002](../20-architecture/adr/0002-self-contained-binary.md)）。缓解仅限应用层。网络层的 volumetric 攻击超出本项目范围 —— 如果用户面临这种威胁，应该自己套隧道或 CDN（架构上支持）。

### T7 shell 集成引入的风险

| 威胁 | 缓解 |
|---|---|
| rcfile 被同机其它用户读取/篡改 | `0600`，放 `$XDG_RUNTIME_DIR/webterm/` 或数据目录下的 `run/`（`0700`），**不放 `/tmp`** |
| 命令注入进 rcfile | rcfile 内容完全由 agent 生成，**不插入任何用户输入** |
| 集成脚本破坏用户 shell | 全部包在 `{…} 2>/dev/null \|\| true`，且不能导致 shell 启动失败（AC-7.7） |
| OSC 带内信令被输出伪造 | **无法防御**（固有问题）。影响限于模式误切与命令记录错误，不涉权限。见 [`../30-protocol/shell-integration.md`](../30-protocol/shell-integration.md#6-已知限制) |

### T8 TLS 相关

| 威胁 | 缓解 |
|---|---|
| autocert 被滥用签发任意域名证书 | `HostPolicy` 严格限定为 `--domain` 的值，**绝不通配**（[ADR-0004](../20-architecture/adr/0004-acme-only-tls.md)） |
| 证书私钥泄露 | `certs/` 目录 `0700` |
| 降级到 HTTP | HSTS `max-age=31536000`；`:80` 除 ACME 挑战外全部 301 |
| 弱 TLS | `MinVersion: tls.VersionTLS12`，优先 TLS 1.3 |

### T9 日志泄露

| 缓解 |
|---|
| 不记录配对码、Cookie token、命令原文（AC-8.5） |
| 不记录终端输出（任何情况下） |
| 记录 IP 与 User-Agent（用于设备列表与限速），这是刻意保留的 |
| `IT-privacy-2` 用 canary 字符串验证 |

## 明确不做的安全措施

| 措施 | 为什么不做 |
|---|---|
| 沙箱化 shell / 限制可执行的命令 | 自欺欺人。用户本来就有这台机器的 shell 权限，webterm 不该假装能限制它 |
| 命令级审计与告警 | 单用户工具，没有"审计谁"的场景。命令历史已经记录了一切 |
| 二次认证执行危险命令 | 会成为纯粹的骚扰。真正的保护是"不要让未授权者进来" |
| 多因素认证（v0.1） | 配对码 + 长效 Cookie 在单用户场景下已足够。Passkey 在 v0.2（那是体验优化，也顺带提升安全） |
| 端到端加密（超越 TLS） | 没有多余的信任边界需要它 |

## 安全 review 清单（每个 PR）

改动涉及以下任一项时，PR 必须在描述里说明安全影响：

- [ ] 新增未认证可达的路由
- [ ] 改动 Cookie 属性、认证中间件、Origin 校验
- [ ] 新增落盘的数据（尤其是否可能包含终端输出）
- [ ] 新增写入日志的字段
- [ ] 改动 rcfile 生成逻辑
- [ ] 新增把服务端数据放进 DOM 的代码
- [ ] 改动 CSP 或 TLS 配置
- [ ] 新增无界的缓冲/队列/集合
