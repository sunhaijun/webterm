# 测试策略

> 状态：Accepted

## 原则

**可测性是架构属性。** [ADR-0002](../20-architecture/adr/0002-self-contained-binary.md) 否决 Cloudflare 方案的决定性理由就是它让完整链路的测试变得不可能。所以：

- 整个系统能在 CI 里一条命令启动（单二进制 + `--dev`）
- 核心功能（断线续传）的测试能**精确控制断开时机**
- `Session` 不知道 WebSocket 的存在，可以无网络单测

## 分层

| 层 | 工具 | 覆盖 | 运行时间目标 |
|---|---|---|---|
| Go 单测 | `go test` | 环形缓冲、OSC 解析、协议编解码、存储查询、认证逻辑 | < 10s |
| Go 集成 | `go test -tags=integration` | 真 PTY、真 SQLite、真 HTTP、真 WebSocket（进程内） | < 60s |
| 前端单测 | Vitest | seq 记账、重发队列、输入模式状态机、keymap、退避 | < 15s |
| E2E | Playwright | 真二进制 + 真浏览器，完整用户流程 | < 5min |

## 关键测试：字节级连续性（AC-2.1）★

这是整个项目最重要的一个测试。它验证"永不断线"这个核心承诺。

### 做法

```
1. 启动 agent（--dev），配对，建立 WebSocket
2. 创建会话，跑一个确定性的输出脚本
   （固定内容、固定顺序、含 ANSI 颜色、含 CJK、含长行、总量 ~2 MB）
3. 记录结束时 xterm 缓冲区的序列化结果（@xterm/addon-serialize）→ 基准
4. 重跑同一脚本，但在输出进行到 30% / 60% 时各强制断开一次 WebSocket
5. 等重连完成、输出跑完
6. 序列化 → 与基准【逐字节比较】
```

### 为什么这个测试有效

它不测"重连能不能连上"（那太弱），而是测**最终屏幕状态是否与从未断线时完全一致**。任何 seq 记账错误、切片偏移、重复回放、丢帧，都会让两次结果不同。

### 变体

| 变体 | 断开方式 | 验证 |
|---|---|---|
| E2E-2a | Playwright 路由拦截切断 WS | 基本续传 |
| E2E-2b | 断开 5 秒（缓冲不溢出） | 增量回放正确 |
| E2E-2c | 断开期间输出 > `ring_bytes` | 走 reset 路径，屏幕**不要求**一致，但要求：无乱码残留、有截断提示、后续输出正确 |
| E2E-2d | 连续快速断开 10 次 | 无累积错位 |
| E2E-3 | 断开期间通过 Composer 提交输入 | 输入不丢、不重、顺序正确 |

E2E-2c 是唯一不要求字节一致的变体 —— 因为 reset 本质上就是丢历史。但它要求**丢的部分之后的内容完全正确**。

## Go 单测清单

### `internal/ringbuf`（见 [`../50-backend/ring-buffer.md`](../50-backend/ring-buffer.md#必测用例)）

`UT-ring-1..9`。其中 `UT-ring-8`（模糊测试，随机 Append/Slice 序列断言不变式）是这个模块最有价值的测试 —— 环形缓冲的 bug 几乎全在边界。

### `internal/oscparse`（见 [`../30-protocol/shell-integration.md`](../30-protocol/shell-integration.md#5-agent-侧-osc-解析器要求)）

`UT-osc-1..9`。其中 `UT-osc-3` 必须**对序列的每个字节位置都切一次**并逐一验证 —— 流式解析器的 bug 就藏在分片边界。

```go
func TestOSCSplitAtEveryByte(t *testing.T) {
    input := []byte("before\x1b]133;D;0\x07after")
    for split := 1; split < len(input); split++ {
        p := oscparse.New()
        out1, ev1 := p.Feed(input[:split])
        out2, ev2 := p.Feed(input[split:])
        assertEqual(t, "beforeafter", string(out1)+string(out2))
        assertEvents(t, append(ev1, ev2...), []Event{CommandEnd{ExitCode: 0}})
    }
}
```

### `internal/protocol`

- 二进制帧编解码往返（含边界：`seq = 0`、`seq = MaxUint64`、`sid = 0`、`payload` 1 字节）
- 非法帧检测（长度不足、空 payload、超大 payload）
- 控制消息 JSON 往返
- **测试向量**：跑 `testdata/vectors.json`，与前端共用同一份 fixture（防实现漂移，协议 §9）

### `internal/store`

- `UT-store-1..4`：历史查询过滤/分页、置顶排序、删除、淘汰保护置顶
- 迁移幂等性：连续跑两次迁移，结果一致
- 权限：创建后文件是 `0600`

### `internal/auth`

- `UT-pair-1..4`：一次性、过期、熵、常数时间比较
- `UT-auth-1`：DB 存的是哈希不是原文

## Go 集成测试清单

用真 PTY + 真 SQLite + 进程内 HTTP server。

| ID | 内容 |
|---|---|
| `IT-session-1..5` | 多会话独立性、上限、自动命名、退出保留缓冲、关闭杀进程组 |
| `IT-resume-1..4` | 断线期间会话不暂停、增量回放不重发、输入重发不丢不重（`in_ack` 跨重连存活）、`instance_id` 不符判 `gone` |
| `IT-shell-1..7` | 命令记录、空格跳过、rcfile 注入、不覆盖用户配置、登录/非登录 profile 链、握手超时、脚本出错不影响 shell |
| `IT-auth-1..4` | 路由认证矩阵（**含 `/ws`**）、Origin 校验、Cookie 属性、吊销即时生效 |
| `IT-pair-1..3` | 二维码输出、配对码不进日志、限速 |
| `IT-tls-1..3` | 用本地假 ACME CA（`internal/acmetest`）验证：真的签出证书并能握手；`--dev` 一次都不找 CA；挑战打不进来时给可读诊断（AC-1.13）。见下方「为什么不用 pebble」 |
| `IT-privacy-1..2` | canary 字符串不出现在数据目录 / 日志中 |
| `IT-embed-1` | 删掉 `web/dist` 后二进制仍能提供前端（证明真的嵌入了） |
| `IT-resize-1` | `resize` 消息导致 PTY 的 `TIOCSWINSZ` 生效（在会话内跑 `stty size` 验证） |
| `IT-hb-1` | 60 秒无帧的连接被关闭 |
| `IT-queue-1` | 会话输入队列满 → `input_stalled`，入队非阻塞，其它会话不受影响（m1） |
| `IT-queue-2` | 连接写队列满 → 关闭该连接而不是阻塞 Session（m2，需要连接层） |
| `IT-sub-1` | 未订阅会话继续缓冲，`subscribe{out_seq}` 补齐正确 |

### 为什么不用 pebble

这一条原本写的是用 [pebble](https://github.com/letsencrypt/pebble)。实际动手时有两个障碍：

1. pebble 会带进来一整棵新的模块依赖（gorilla/mux、miekg/dns…）。它是测试专用的，但仍然进 `go.sum`。
2. **pebble 的 VA 会做真实 DNS 解析**去验证 HTTP-01。测试域名得能解析到本机，绕它要么改 `/etc/hosts`、要么给 pebble 挂自定义 DNS —— 两条都依赖 CI 环境。

`internal/acmetest` 是一个约 300 行的进程内 RFC 8555 服务器：零新依赖、不碰网络、不需要 DNS（验证目标地址由测试直接指定），三条测试合计跑 1 秒出头。

它**刻意不校验 JWS 签名** —— 那对下面要证明的东西没有贡献。

它证明的是**我们这边的接线**：autocert 配置正确、`:80` 上的挑战 handler 真的能被取到（包括 `HostPolicy` 对 `Host` 头的校验）、启动预热真的拿到证书并落盘 0700、证书真的能用来完成 TLS 握手、失败时给出可读诊断。

它**不**证明我们与 Let's Encrypt 的协议兼容性 —— 那是 `golang.org/x/crypto/acme` 的职责，上游有自己的测试。真实签发仍然只能靠 [手动检查清单](manual-checklist.md)。

> 这三条测试上线当天就抓到一个真 bug：autocert 会把挑战类型逐个试完，最终抛的是
> `no viable challenge type found`，而诊断只匹配 `Invalid response` ——
> 也就是说**最常见的真实故障（安全组没放行）根本走不到那段诊断**。
> 这正是"只有手动验证"覆盖不到的东西。

**shell 集成测试需要真 bash。** CI 里确保有 bash 4.4+；测试跑一个受控的 `.bashrc`（通过 `HOME` 指向临时目录）以获得确定性。

## 前端单测清单（Vitest）

| ID | 内容 |
|---|---|
| `UT-seq-1` | `out_seq` 记账：连续帧、空洞检测、重复检测 |
| `UT-input-1..3` | bracketed paste 包裹、composition 期间不发送、输入框属性 |
| `UT-mode-1..2` | 模式状态机转移表、`running` 去抖、`locked` 行为 |
| `UT-keymap-1` | 控制键映射表（对照 [`../40-frontend/keymap.md`](../40-frontend/keymap.md)） |
| `UT-reconnect-1` | 指数退避序列、抖动范围、`online` 事件立即重试 |
| `UT-hb-1` | 心跳间隔、pong 超时判死 |
| `UT-resize-1` | resize 防抖 |
| `UT-render-1` | WebGL 失败时回退不抛异常 |
| `UT-name-1` | 会话自动命名规则（home → `~`、`/` → `/`、手动名优先） |
| 协议向量 | 跑 `internal/protocol/testdata/vectors.json`（与 Go 侧同一份） |

## E2E 清单

场景详情见 [`e2e-scenarios.md`](e2e-scenarios.md)。

## CI

```yaml
jobs:
  go:        go vet, golangci-lint, go test ./..., go test -tags=integration ./...
  static:    CGO_ENABLED=0 go build; ldd 断言 "not a dynamic executable"   # AC-8.1
  web:       npm run lint, npm run typecheck, npm test
  e2e:       npm run build → go build（含 embed）→ npx playwright test
```

E2E 的前置是完整构建 —— 这保证了 `go:embed` 的路径是真的通的。

## 覆盖率

不设硬性覆盖率门槛（会诱导写无意义的测试）。但以下模块**必须有近乎完全的分支覆盖**，review 时人工确认：

- `internal/ringbuf`
- `internal/oscparse`
- `internal/protocol`
- `web/src/conn`（seq 记账与重发队列）

这四个是"断线续传"的全部实现。它们错了，产品的核心承诺就是假的。

## 手工测试清单

有些东西自动化不了 —— 真实输入法、真实软键盘、真实网络切换、真实证书签发。
完整清单见 [`manual-checklist.md`](manual-checklist.md)，**每次发布前跑一遍**。
