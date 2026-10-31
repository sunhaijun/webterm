# webterm 开发约定

## 文档驱动

`docs/` 是唯一事实来源，代码是它的实现。顺序永远是：

```
改 docs  →  按 docs 写测试  →  写实现  →  测试通过  →  PR
```

- 改协议**必须**先改 `docs/30-protocol/websocket-protocol.md`。前后端都以它为准，不允许一边先改。
- 新增架构决策写一篇 `docs/20-architecture/adr/NNNN-*.md`，不要塞进别的文档。
- 需求变更改 `docs/10-requirements/`，并同步 `docs/70-testing/e2e-scenarios.md`。
- 文档里写不出验收标准的需求，说明它还没想清楚，不要开始写代码。

## 分支与 worktree

每个里程碑一个 worktree 分支，分支名对应它落地的 docs 编号：

```
feat/<docs编号>-<主题>      例：feat/30-protocol-core
```

流程：`git worktree add` → 开发 → 自测通过 → PR 到 `main` → 合并后删 worktree。
不在 `main` 上直接开发。

里程碑清单见 `docs/90-roadmap/milestones.md`。

## 测试要求

任何 PR 必须满足：

- Go：`go test ./...` 全绿，新增逻辑有单测
- 前端：`npm test` 全绿
- E2E：本地 `npm run e2e` 全绿；若改动触及协议、重连、输入或布局，必须在 `docs/70-testing/e2e-scenarios.md` 里加/改场景
- **E2E 在 CI 上不跑**（太费 Actions 额度）。没有兜底，所以本地那一遍就是门槛：跑不动就先修环境（`docs/80-ops/development.md` §E2E 的两个坑），别提 PR。真想要 CI 上的结论就手动 `gh workflow run E2E --ref <分支>`，见 `docs/70-testing/strategy.md` §CI
- 涉及续传的改动，**必须**跑通两条：增量路径的「字节级连续性」（同一段输出，中途掐断 WebSocket 后的终端缓冲区序列化结果，与不掐断时逐字节一致），以及快照路径的「屏幕级一致性」（xterm 先吃快照再吃之后的字节，逐格等于直接吃全部字节，[ADR-0026](docs/20-architecture/adr/0026-agent-holds-terminal-state.md) §10）
- 涉及会话状态（`internal/session` 的字段、ringbuf、`internal/vterm`）的改动，**必须**跑通「跨交接的字节级连续性」测试（`TestHandoffByteLevelContinuity`），并检查新字段是否要进 `internal/handoff.Session` 快照
- 涉及连接层的改动，**必须**确认读写两侧的队列都不阻塞（一条 WebSocket 复用所有会话，任一侧阻塞都会波及全部会话）

## 不变式（改代码时别破坏）

1. **单二进制**：不引入 cgo，不引入外部运行时依赖。`GOOS=linux GOARCH=amd64 go build` 必须直接出货。
2. **同源**：前端由 agent 自己用 `go:embed` 提供，不引入独立前端域名。
3. **输出不落盘**：终端输出只在内存里（环形缓冲与终端模拟器）。落盘的只有设备与认证数据。
4. **序列号连续**：发给客户端的字节流序列号 = 会话累计的 PTY 输出字节数。agent **不改写**输出流；`SNAPSHOT` 帧是 agent 生成的渲染指令，**不计入 seq**（[协议 §3](docs/30-protocol/websocket-protocol.md)）。
5. **认证前置**：除 `/pair`、静态资源和健康检查外，所有路由（含 WebSocket 升级）都要求有效设备会话。

## 技术栈

- Go 1.27+：`creack/pty` · `coder/websocket` · `modernc.org/sqlite`（纯 Go）· `golang.org/x/crypto/acme/autocert` · `tuios.dev/vt`（纯 Go 终端模拟器，钉死版本，只经 `internal/vterm` 使用）
- 前端：TypeScript + Vite + Preact + xterm.js
- 测试：`go test` / Vitest / Playwright
