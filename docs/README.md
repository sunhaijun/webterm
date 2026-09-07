# webterm 文档

`docs/` 是 webterm 的唯一事实来源。代码是文档的实现，不是反过来。

## 怎么读

第一次接触，按这个顺序：

1. [`00-overview/vision.md`](00-overview/vision.md) — 这东西是什么，为什么不是又一个 ttyd
2. [`00-overview/non-goals.md`](00-overview/non-goals.md) — **明确不做什么**，以及已接受的取舍
3. [`10-requirements/user-stories.md`](10-requirements/user-stories.md) — 用户故事
4. [`20-architecture/overview.md`](20-architecture/overview.md) — 整体架构与数据流
5. [`30-protocol/websocket-protocol.md`](30-protocol/websocket-protocol.md) — ★ 前后端契约

## 目录

| 目录 | 内容 |
|---|---|
| [`00-overview/`](00-overview/) | 愿景、非目标、术语表 |
| [`10-requirements/`](10-requirements/) | 用户故事、验收标准、设备与布局矩阵 |
| [`20-architecture/`](20-architecture/) | 架构总览、架构决策记录（ADR） |
| [`30-protocol/`](30-protocol/) | ★ WebSocket 协议、HTTP API、bash shell 集成协议 |
| [`40-frontend/`](40-frontend/) | 响应式布局、输入模式、会话交互、命令交互、快捷键 |
| [`50-backend/`](50-backend/) | 会话管理与 PTY 生命周期、环形缓冲、存储模型 |
| [`60-security/`](60-security/) | 威胁模型、认证与配对、历史隐私 |
| [`70-testing/`](70-testing/) | 测试策略、E2E 场景清单、手工测试清单 |
| [`80-ops/`](80-ops/) | 安装、开发与测试、TLS、systemd、排障 |
| [`90-roadmap/`](90-roadmap/) | 里程碑与分支计划 |

★ = 前后端契约，改动必须先改文档。

## 维护规则

- **协议先行**：任何影响 `/ws` 消息格式的改动，先改 `30-protocol/websocket-protocol.md`，再改代码。前后端不允许一边先改。
- **决策留档**：架构层面的选择写成 ADR（`20-architecture/adr/NNNN-*.md`），一个决策一篇，包含被否决的方案和否决理由。ADR 一旦合入不改写，要推翻就写新的一篇并把旧的标记为 `Superseded`。
- **需求可测**：`10-requirements/acceptance-criteria.md` 里的每一条都必须能落到 `70-testing/` 的一个具体测试上。写不出测试的需求 = 还没想清楚。
- **同步更新**：改需求就改验收标准，改验收标准就改 E2E 场景。三者不允许漂移。

## 文档状态标记

每篇文档头部有状态：

- `Draft` — 讨论中，不可据此写代码
- `Accepted` — 已确认，实现以此为准
- `Superseded by X` — 已被取代
