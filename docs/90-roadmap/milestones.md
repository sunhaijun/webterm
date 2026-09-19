# 里程碑与分支计划

> 状态：Accepted

## v0.1 的定义

**"日常能替代我现在的 SSH 工作流"的最小完整品** —— 不是技术演示。

判断标准：v0.1 发布后，我在通勤路上能用手机真的改点东西、看日志、重启服务，且不会因为网络抖动丢现场。

## 分支规则

```
feat/<docs编号>-<主题>
```

分支名对应它落地的 docs 目录编号。每个里程碑一个 worktree 分支，PR 到 `main`，合并后删 worktree。不在 `main` 上直接开发。

每个 PR 必须：先改/补对应 doc → 按 doc 写测试 → 实现 → 测试全绿。

---

## m0 · `feat/00-docs-baseline`

**文档基线。** 本轮产出。

- `docs/` 全部结构与内容
- `CLAUDE.md` 开发约定
- 需求、验收标准、ADR、协议契约

**出口标准**：`docs/10-requirements/acceptance-criteria.md` 里每条都能落到一个具体测试；协议文档详细到可以据此直接写测试向量。

---

## m1 · `feat/30-protocol-core`

**协议与会话核心。没有网络、没有前端。**

| 交付 | 对应文档 |
|---|---|
| `internal/ringbuf` | [ring-buffer.md](../50-backend/ring-buffer.md) |
| `internal/oscparse` | [shell-integration.md §5](../30-protocol/shell-integration.md#5-agent-侧-osc-解析器要求) |
| `internal/protocol` + `testdata/vectors.json` | [websocket-protocol.md](../30-protocol/websocket-protocol.md) |
| `internal/session`（Session / SessionManager / 真 PTY） | [session-manager.md](../50-backend/session-manager.md) |
| `internal/store` + 迁移 | [storage-schema.md](../50-backend/storage-schema.md) |

**测试**：`UT-ring-1..9`、`UT-osc-1..9`、协议编解码 + 测试向量、`UT-store-1..4`、`IT-session-1..5`、`IT-resume-1..4`、`IT-queue-1`

**出口标准**：`IT-resume-*` 通过 —— **在没有浏览器的情况下证明续传逻辑是对的**。这是整个项目风险最高的部分，先用最便宜的测试手段打穿它。

配套一条无浏览器版的字节级连续性测试（`TestByteLevelContinuity`）：同一段确定性输出跑两遍，第二遍中途断开重连若干次，断言两次收到的字节流完全一致。E2E-2 会在真浏览器 + xterm 序列化的层面再测一遍。

---

## m2 · `feat/50-agent-serve`

**能跑起来的服务。**

| 交付 | 对应文档 |
|---|---|
| HTTP 路由、认证中间件（**含 `/ws`**） | [auth-pairing.md](../60-security/auth-pairing.md) |
| 配对码 + 二维码 + 设备管理 REST | 同上 + [http-api.md](../30-protocol/http-api.md) |
| WebSocket 连接层（订阅、seq 记账、慢客户端保护） | [websocket-protocol.md](../30-protocol/websocket-protocol.md) |
| autocert TLS + `--dev` | [ADR-0004](../20-architecture/adr/0004-acme-only-tls.md) |
| `webterm doctor` / `pair` / `devices` / `version` | [install.md](../80-ops/install.md) |
| systemd unit + 安装文档 | [systemd.md](../80-ops/systemd.md) |
| 限速、CSP、HSTS、日志脱敏 | [threat-model.md](../60-security/threat-model.md) |

**测试**：`IT-auth-1..4`、`IT-pair-1..3`、`IT-tls-1..3`、`IT-hb-1`、`IT-sub-1`、`IT-queue-2`、`IT-privacy-1..2`

**出口标准**：能在真服务器上跑起来，拿到真证书，用 `wscat` 之类的工具手工建连、创建会话、跑命令。

"手工建连"这一步已经自动化：进程内起完整 agent（真 store / 真 PTY / 真 HTTP / 真 WebSocket），跑完配对 → 建连 → 建会话 → 敲命令 → 看到输出的全流程。真证书那一步仍然只能上真服务器验（手工清单）。

---

## m3 · `feat/40-web-shell`

**前端骨架 + 无感重连。**

| 交付 | 对应文档 |
|---|---|
| Vite + TS + Preact 工程、`go:embed` 集成 | [architecture/overview.md](../20-architecture/overview.md) |
| `web/src/conn`：连接层、seq 记账、重发队列、指数退避、心跳 | [websocket-protocol.md §5](../30-protocol/websocket-protocol.md#5-续传机制) |
| `web/src/term`：xterm 封装、WebGL、滚动、搜索 | [layout-responsive.md](../40-frontend/layout-responsive.md) |
| 连接状态指示 | [session-ux.md](../40-frontend/session-ux.md#连接状态指示ac-210) |
| Playwright 夹具与确定性输出脚本 | [e2e-scenarios.md](../70-testing/e2e-scenarios.md#测试夹具) |

**测试**：`UT-seq-1`、`UT-reconnect-1`、`UT-hb-1`、`UT-render-1`、**`E2E-1`、`E2E-2a..2d`、`E2E-3`、`E2E-4`、`E2E-5`、`E2E-12`**

**出口标准**：★ **`E2E-2a` 字节级连续性测试通过。** 这是整个项目最关键的一道门 —— 过了它，"永不断线"这个承诺就有了机械化的证据。

---

## m4 · `feat/40-input-modes`

**双模输入。**

| 交付 | 对应文档 |
|---|---|
| Composer：多行、IME、历史导航、bracketed paste 提交 | [input-modes.md](../40-frontend/input-modes.md) |
| Raw：按键映射、composition 处理、内联预览浮层 | 同上 + [keymap.md](../40-frontend/keymap.md) |
| 模式状态机（含 `running` 去抖、`locked`） | [input-modes.md §状态机](../40-frontend/input-modes.md#状态机) |
| 移动端功能键条 + 粘滞修饰键 | 同上 |
| `visualViewport` 软键盘适配 | [layout-responsive.md](../40-frontend/layout-responsive.md#高度计算) |

**测试**：`UT-input-1..3`、`UT-mode-1..2`、`UT-keymap-1`、`UT-resize-1`、**`E2E-7`、`E2E-8`、`E2E-10`**、`IT-resize-1`

**出口标准**：真机上写一段 300 字的中文 prompt，体验不比本地编辑器差。（自动化测到 composition 事件层面，真机验证进手工清单。）

> 注：此时模式自动切换还没有数据源（m5 才有 shell 集成），所以 m4 里自动切换的代码写好但走的是"手动 + 默认 Composer"路径，`E2E-9` 留到 m5。

---

## m5 · `feat/30-shell-integration`

**shell 集成 —— 一份脚本喂饱四个功能。**

| 交付 | 对应文档 |
|---|---|
| `internal/shellinit/bash.sh` + rcfile 注入 | [shell-integration.md](../30-protocol/shell-integration.md) + [ADR-0010](../20-architecture/adr/0010-bash-rcfile-injection.md) |
| 命令记录落库（`command.start` / `command.end`） | [storage-schema.md](../50-backend/storage-schema.md#写入路径) |
| CWD 上报 + 会话自动命名 | [session-manager.md](../50-backend/session-manager.md#自动命名ac-44) |
| `prompt{state}` → **输入模式自动切换真正生效** | [ADR-0007](../20-architecture/adr/0007-dual-mode-input.md) |
| 集成状态机与降级提示 | [session-manager.md](../50-backend/session-manager.md#集成状态机ac-76) |
| `webterm shell-init bash` 子命令 | [install.md](../80-ops/install.md) |

**测试**：`IT-shell-1..7`、`UT-name-1`、**`E2E-9`、`E2E-13`**

**出口标准**：装了集成之后，`echo hi` 有历史记录（含退出码耗时）、会话名自动变成目录名、跑 `vim` 自动切 Raw 退出自动切回；**破坏集成之后终端照常可用**。

> m5 里顺带落地了输入模式状态机（`web/src/input/modes.ts`），因为它是这批数据的直接消费者，`E2E-9` 少了它就没法测。m4 在它上面加 IME、历史导航、功能键条与软键盘适配。

---

## m6 · `feat/40-sessions-ux`

**多会话 + 响应式布局 + PWA。**

| 交付 | 对应文档 |
|---|---|
| 会话列表、切换、未读、自动命名显示 | [session-ux.md](../40-frontend/session-ux.md) |
| 三档布局（desktop 侧栏 / tablet 抽屉 / phone sheet + 滑动） | [layout-responsive.md](../40-frontend/layout-responsive.md) |
| `short` 布局（手机横屏） | 同上 |
| 已退出会话的保留与"重开" | [session-ux.md](../40-frontend/session-ux.md#已退出会话的保留ac-45) |
| 订阅策略 + "保持接收"开关 | [session-ux.md](../40-frontend/session-ux.md#订阅策略) |
| 主题（三态）、字号、PWA + Service Worker | [layout-responsive.md](../40-frontend/layout-responsive.md#pwa) |

**测试**：**`E2E-6`、`E2E-11`、`E2E-15`、`E2E-16`、`E2E-17`**

**出口标准**：手机上同时管三个会话不觉得别扭；能装到主屏。

---

## m7 · `feat/40-commands`

**历史 + 快捷命令。**

| 交付 | 对应文档 |
|---|---|
| `/api/commands*` 与 `/api/settings` | [http-api.md](../30-protocol/http-api.md) |
| 历史面板（搜索、过滤、分组、退出码显示） | [commands-ux.md](../40-frontend/commands-ux.md#历史面板) |
| 置顶（☆）→ 快捷命令；label、拖动排序 | 同上 |
| 移动端快捷命令条 | 同上 |
| ~~命令面板（`Ctrl/Cmd+K`，模糊搜索会话/快捷命令/历史/动作）~~ | 已随 [ADR-0022](../20-architecture/adr/0022-drop-command-palette.md) 删除 |
| Composer 历史导航接真实数据源 | [input-modes.md](../40-frontend/input-modes.md#历史导航) |
| 删除 / 清空 / 淘汰保护置顶 | [storage-schema.md](../50-backend/storage-schema.md#淘汰ac-610) |
| 隐私说明（空格前缀）进设置页与引导 | [privacy-history.md](../60-security/privacy-history.md) |

**测试**：**`E2E-14`**、`UT-store-*` 补全

**出口标准**：v0.1 发布。手机上点两下就能重启服务。

---

## v0.1 的自动化边界

m0–m7 全部落地之后，**能机械化验证的都验证了**：Go 单测与集成测试、前端
144 个单测、30 个 E2E（含 ★ 字节级连续性）。

**剩下这些只能靠真机**，见 [`../70-testing/manual-checklist.md`](../70-testing/manual-checklist.md)：

| 项 | 为什么自动化不了 |
|---|---|
| 真实输入法的候选框位置、组字期间切候选 | Playwright 只能派发 composition 事件，派发不出真实 IME 的行为 |
| 真实软键盘的弹出与布局 | 无头浏览器没有软键盘，只能模拟 `visualViewport` 变化 |
| 真实网络切换（Wi-Fi ↔ 4G ↔ 隧道） | 路由拦截与 CDP 模拟的都不是真实链路 |
| 真实 Let's Encrypt 签发 | CI 里只能打 pebble，打真的会撞限流 |
| PWA 真机安装、触觉反馈 | 需要真设备 |

**这几条没跑过就不算发布。** —— 2026-09-14 在真机上过了一轮（清单 8 组 60 项全勾，
见 [`../70-testing/manual-checklist.md`](../70-testing/manual-checklist.md) §记录），
v0.1 的出口标准至此满足，`v0.1.0` 随之发布。下一个正式版本发布前要再跑一遍。

---

## 依赖关系

```
m0 ──> m1 ──> m2 ──> m3 ──> m4 ──> m6 ──> m7
                             │      ↑
                             └─ m5 ─┘
```

- **m1 → m2 → m3 是严格串行**（协议 → 服务 → 客户端）
- **m4（输入模式）与 m5（shell 集成）可以并行**：m4 写状态机但走手动路径，m5 提供数据源。两者合并后 `E2E-9` 才能过
- **m6 依赖 m4**（布局要处理 Composer/功能键条的高度）
- **m7 依赖 m5**（历史数据源）和 m6（面板要放进布局）

---

## v0.2（不承诺时间）

**排在最前面：回滚历史的四步**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）—— 内容层（把全屏 AI CLI 拉回主屏）→ 手势与渲染层（拖动跟手、写入有预算）→ 持久层（刷新后的客户端快照）→ 备用屏层（拖动转滚轮上报）。四步独立可交付、独立可回退，**前两步就能兑现日常体感**；一条协议消息都不加。分支 `feat/20-scrollback-model`。

其余按价值排序：

1. **命令块可视化** —— 折叠、跳转、块内复制、按退出码筛选。数据在 m5 已经采好（`command.start/end` 已带 `out_seq`），**协议不需要改**
2. **Web Push 通知** —— 长命令跑完提醒。依赖 m5 的命令结束事件
3. **文件浏览 + 上传下载** —— 独立功能面
4. **Passkey / WebAuthn** —— 填补"新设备接入需要访问服务器终端"的缺口
5. **zsh 集成** —— `preexec`/`precmd` 天然存在，比 bash 干净
6. **Composer 的 Tab 补全** —— 需要新的控制消息与独立的补全通道
7. **桌面端分屏**

## v0.3+ 的候选

- ~~**无损升级**~~ —— 已做：[ADR-0016](../20-architecture/adr/0016-hot-reexec.md) 原地 re-exec 交接会话（`webterm reload`）。剩下的候选是拆前台 / 会话宿主两进程，让前台崩溃也不丢会话
- **SSH 跳板**：agent 内加 SSH 出站，连没装 agent 的机器（[ADR-0001](../20-architecture/adr/0001-agent-first-no-ssh.md) 的分层）
- **多用户**：需要数据模型迁移
- **本地回显预测**（mosh 式）
- **命令历史 FTS5**：等 `LIKE` 真的慢了再说
