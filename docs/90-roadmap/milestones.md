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
| `internal/oscparse` | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
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
| `web/src/term`：xterm 封装、WebGL、滚动 | WebGL 与自写滚动已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 改用 xterm 原生，见 [layout.md](../40-frontend/layout.md) |
| 连接状态指示 | [session-ux.md](../40-frontend/session-ux.md) |
| Playwright 夹具与确定性输出脚本 | [e2e-scenarios.md](../70-testing/e2e-scenarios.md#测试夹具) |

**测试**：`UT-seq-1`、`UT-reconnect-1`、`UT-hb-1`、`UT-render-1`、**`E2E-1`、`E2E-2a..2d`、`E2E-3`、`E2E-4`、`E2E-5`、`E2E-12`**

**出口标准**：★ **`E2E-2a` 字节级连续性测试通过。** 这是整个项目最关键的一道门 —— 过了它，"永不断线"这个承诺就有了机械化的证据。

---

## m4 · `feat/40-input-modes`

**双模输入。**

| 交付 | 对应文档 |
|---|---|
| Composer：多行、IME、历史导航、bracketed paste 提交 | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 删除（换成文本输入页） |
| Raw：按键映射、composition 处理、内联预览浮层 | [input.md](../40-frontend/input.md) + [keymap.md](../40-frontend/keymap.md) |
| 模式状态机（含 `running` 去抖、`locked`） | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 删除 |
| 移动端功能键条 + 粘滞修饰键 | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 换成附加键，见 [input.md](../40-frontend/input.md) |
| `visualViewport` 软键盘适配 | [layout.md](../40-frontend/layout.md) |

**测试**：`UT-input-1..3`、`UT-mode-1..2`、`UT-keymap-1`、`UT-resize-1`、**`E2E-7`、`E2E-8`、`E2E-10`**、`IT-resize-1`

**出口标准**：真机上写一段 300 字的中文 prompt，体验不比本地编辑器差。（自动化测到 composition 事件层面，真机验证进手工清单。）

> 注：此时模式自动切换还没有数据源（m5 才有 shell 集成），所以 m4 里自动切换的代码写好但走的是"手动 + 默认 Composer"路径，`E2E-9` 留到 m5。

---

## m5 · `feat/30-shell-integration`

**shell 集成 —— 一份脚本喂饱四个功能。**

| 交付 | 对应文档 |
|---|---|
| `internal/shellinit/bash.sh` + rcfile 注入 | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| 命令记录落库（`command.start` / `command.end`） | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| CWD 上报 + 会话自动命名 | CWD 改读 `/proc`（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)），自动命名见 [session-manager.md](../50-backend/session-manager.md#自动命名ac-44) |
| `prompt{state}` → **输入模式自动切换真正生效** | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 与 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| 集成状态机与降级提示 | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| `webterm shell-init bash` 子命令 | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |

**测试**：`IT-shell-1..7`、`UT-name-1`、**`E2E-9`、`E2E-13`**

**出口标准**：装了集成之后，`echo hi` 有历史记录（含退出码耗时）、会话名自动变成目录名、跑 `vim` 自动切 Raw 退出自动切回；**破坏集成之后终端照常可用**。

> m5 里顺带落地了输入模式状态机（`web/src/input/modes.ts`），因为它是这批数据的直接消费者，`E2E-9` 少了它就没法测。m4 在它上面加 IME、历史导航、功能键条与软键盘适配。

---

## m6 · `feat/40-sessions-ux`

**多会话 + 响应式布局 + PWA。**

| 交付 | 对应文档 |
|---|---|
| 会话列表、切换、未读、自动命名显示 | [session-ux.md](../40-frontend/session-ux.md) |
| 三档布局（desktop 侧栏 / tablet 抽屉 / phone sheet + 滑动） | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 换成两种形态，见 [layout.md](../40-frontend/layout.md) |
| `short` 布局（手机横屏） | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 删除 |
| 已退出会话的保留与"重开" | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 换成进程结束提示行，见 [session-ux.md](../40-frontend/session-ux.md) |
| 订阅策略 + "保持接收"开关 | [session-ux.md](../40-frontend/session-ux.md) |
| 主题（三态）、字号、PWA + Service Worker（主题后由 [ADR-0030](../20-architecture/adr/0030-no-settings.md) 改为只跟随系统，字号固定） | [layout.md](../40-frontend/layout.md) |

**测试**：**`E2E-6`、`E2E-11`、`E2E-15`、`E2E-16`、`E2E-17`**

**出口标准**：手机上同时管三个会话不觉得别扭；能装到主屏。

---

## m7 · `feat/40-commands`

**历史 + 快捷命令。**

| 交付 | 对应文档 |
|---|---|
| `/api/commands*` 与 `/api/settings` | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| 历史面板（搜索、过滤、分组、退出码显示） | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 删除 |
| 置顶（☆）→ 快捷命令；label、拖动排序 | 同上 |
| 移动端快捷命令条 | 同上 |
| ~~命令面板（`Ctrl/Cmd+K`，模糊搜索会话/快捷命令/历史/动作）~~ | 已随 [ADR-0022](../20-architecture/adr/0022-drop-command-palette.md) 删除 |
| Composer 历史导航接真实数据源 | 已随 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) 删除 |
| 删除 / 清空 / 淘汰保护置顶 | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除 |
| 隐私说明（空格前缀）进设置页与引导 | 已随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除（不再记命令） |

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

## Termux 式界面与输出链路（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)、[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）

老界面（互切键、编辑面板、上下文键区、侧栏、横滑、视觉缩放、历史面板）整体删除，换成全屏终端 + 两行静态附加键；手机用 ☰ + 底部会话抽屉，PC / Pad 用顶部标签栏。输出链路改成 agent 持有终端状态（增量 / 快照两条路），shell 集成与命令历史随之删除。

```
m8 ──> m9
 └───> m10
```

m9 / m10 只依赖 m8，彼此独立。

---

## m8 · `feat/40-termux-shell`

**一个 PR：清除老界面、重建输出链路、删掉随之变成死代码的后端。**

| 交付 | 对应文档 |
|---|---|
| ADR-0025 / ADR-0026 与前端、协议、后端、需求、E2E 文档重写 | [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §11、[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §影响 |
| 删除老界面代码与对应测试（ADR-0025 §9 清单），`app.tsx` 拆成只做装配的 `app/` | ADR-0025 §9 |
| 形态判定（屏幕短边 600px 分 `compact` / `wide`） | [layout.md](../40-frontend/layout.md#形态ac-518) |
| 两行静态附加键（Termux 默认 14 键，CTRL / ALT 粘滞，DECCKM） | [input.md](../40-frontend/input.md#附加键ac-318) + [keymap.md](../40-frontend/keymap.md) |
| 文本输入页（✎ / 左右滑动切换；回车：有内容不追加回车、空回车发 `\r`；后由 [ADR-0027](../20-architecture/adr/0027-text-page-enter-submits.md) 改为发内容并回车） | [input.md](../40-frontend/input.md) |
| `compact`：☰ + 底部会话抽屉（未读点、系统返回键关抽屉）；`wide`：顶部标签栏（☰ 后由 [ADR-0030](../20-architecture/adr/0030-no-settings.md) 换成显示会话数的会话按钮，设置删除） | [session-ux.md](../40-frontend/session-ux.md#切换会话ac-410) |
| 点终端切换软键盘 / 鼠标跟踪时上报点击；滚动用 xterm 原生；鼠标跟踪时纵向拖转滚轮（后由 [ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md) 补上） | [layout.md](../40-frontend/layout.md) |
| 连接横幅（覆盖、不改几何）、进程结束提示行、删除 `Ctrl/Cmd+F` 搜索 | [session-ux.md](../40-frontend/session-ux.md) |
| `internal/vterm`（tuios.dev/vt）：同锁喂入、快照、改列数重发快照、热升级交接状态 | [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)、[session-manager.md](../50-backend/session-manager.md) |
| 协议 v2：`SNAPSHOT` 帧、`resumed[].status: "snapshot"`；删 `ATTR_PREFIX` / `reset` / `redraw` / `cwd` / `prompt` / `command.*`；同步 `vectors.json` | [websocket-protocol.md](../30-protocol/websocket-protocol.md) |
| 环形缓冲缩到 256 KiB、按字节裁剪 | [ring-buffer.md](../50-backend/ring-buffer.md) |
| 删 `termstate` / `oscparse` / `shellinit`、命令历史（迁移 `0003` DROP `commands`）、`/api/commands*` / `/api/fs` / `/api/settings`、`--no-history` / `--no-shell-integration` / `shell-init`；CWD 读 `/proc` | [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §6、[storage-schema.md](../50-backend/storage-schema.md)、[http-api.md](../30-protocol/http-api.md) |
| 前端输出路径原生化：流式 `TextDecoder`、删按帧合并 / 回看暂停 / 预算写入 / WebGL / 自写滚动 / 客户端快照 | [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7 |
| 录制夹具 + Vitest（`@xterm/headless` 当裁判）的屏幕级一致性测试 | [strategy.md](../70-testing/strategy.md) |
| E2E 脚手架：敲命令改成直接往终端里敲 | [e2e-scenarios.md](../70-testing/e2e-scenarios.md) |

**测试**：AC-3.18 / 3.19 / 3.20 / 4.10 / 5.18 与 AC-2.21 / 2.22 / 2.23 对应的单测与 E2E；改写的 E2E；`TestHandoffByteLevelContinuity`；协议测试向量两侧对齐

**出口标准**：`go test ./...`、`npm test`、`npm run e2e` 全绿；★ **增量的字节级连续性（E2E-2）与快照的屏幕级一致性都过**；`TestHandoffByteLevelContinuity` 过。

---

## m9 · `feat/40-termux-keys`

**附加键增强**（ADR-0025 §2）。

| 交付 | 对应文档 |
|---|---|
| 上划副键（默认 `-` → `\|`、`/` → `~`） | [input.md](../40-frontend/input.md) |
| 长按连发（`↑ ↓ ← → PGUP PGDN`，400ms 后每 60ms） | 同上 |

**测试**：本分支新增的验收标准与对应单测 / E2E

**出口标准**：同 m8。

---

## m10 · `feat/40-termux-gestures`

**手势**（ADR-0025 §5、§6）。

| 交付 | 对应文档 |
|---|---|
| 双指捏合改字号：过程中只做 CSS 预览，松手改 `fontSize` + `fit()` + 补发 `resize`，按形态保存 | [layout.md](../40-frontend/layout.md) |
| 长按选区：选词、拖手柄、「复制 · 粘贴 · 更多」（选择链接 / 分享 / 保持亮屏） | 同上 |
| 响铃振动（Android） | 同上 |

**测试**：本分支新增的验收标准与对应 E2E；真机手势进[手工清单](../70-testing/manual-checklist.md)

**出口标准**：同 m8。

---

## v0.2（不承诺时间）

按价值排序（回滚历史已由 [ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §1 与 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 解决）：

1. **文件浏览 + 上传下载** —— 独立功能面
2. **Passkey / WebAuthn** —— 填补"新设备接入需要访问服务器终端"的缺口
3. **桌面端分屏**

## v0.3+ 的候选

- ~~**无损升级**~~ —— 已做：[ADR-0016](../20-architecture/adr/0016-hot-reexec.md) 原地 re-exec 交接会话（`webterm reload`）。剩下的候选是拆前台 / 会话宿主两进程，让前台崩溃也不丢会话
- **SSH 跳板**：agent 内加 SSH 出站，连没装 agent 的机器（[ADR-0001](../20-architecture/adr/0001-agent-first-no-ssh.md) 的分层）
- **多用户**：需要数据模型迁移
- **本地回显预测**（mosh 式）
