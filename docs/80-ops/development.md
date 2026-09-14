# 开发与测试

> 状态：Accepted
>
> 部署见 [`install.md`](install.md)。这篇是给改代码的人看的。

## 前置

| | 版本 | 用途 |
|---|---|---|
| Go | 1.27+ | agent 本体 |
| Node | 22+ | 构建前端、跑 Vitest 与 Playwright |
| bash | 4.4+ | shell 集成的集成测试要真 bash |
| Python 3 | 任意 | 文档链接检查脚本 |

Node 只在**构建时**需要，产物是单个静态二进制。

## 构建

```bash
cd web && npm ci && npm run build && cd ..
CGO_ENABLED=0 go build -o webterm ./cmd/webterm
```

**顺序不能反。** 前端产物（`internal/webui/dist`）是 `go:embed` 的输入，
反了的话嵌进去的是空目录 —— 二进制会跑起来，但访问首页时明说
「这个二进制没有嵌入前端产物」。

`internal/webui/dist/` 里只有一个 `.gitkeep` 入库：产物不入库，但目录必须
存在，否则 `go:embed` 找不到它，**整个仓库连编都编不过**。

## 测试

四层，见 [`../70-testing/strategy.md`](../70-testing/strategy.md)。

```bash
# Go：单测 + 集成测试（真 PTY、真 SQLite、真 HTTP、真 WebSocket）
go vet ./...
go test ./...
go test ./... -race

# 前端单测（含与 Go 侧共用的协议向量）
cd web && npm run typecheck && npm test

# E2E：真二进制 + 真浏览器
cd web && npx playwright install chromium && npm run e2e

# 文档链接（docs/ 是唯一事实来源，坏链是文档腐烂的第一个信号）
python3 scripts/check-doc-links.py
```

### E2E 的两个坑

**1. Chromium 需要系统库。**

```bash
npx playwright install --with-deps chromium   # 需要 sudo
# 或者只装浏览器，自己补库：
sudo apt install -y libnss3 libnspr4
```

缺库时 Chromium 直接起不来（`error while loading shared libraries: libnspr4.so`），
E2E 全部失败，看起来像代码坏了。

**2. 别把三套测试串在一条命令里跑。**

`go test ./...` 会起一堆真 PTY 与 SQLite，Playwright 会起 Chromium。在小内存
机器（4 GB 以下）上峰值叠加会触发系统的低内存回收。一套一套跑。

### E2E 是跑真二进制的

`web/e2e/harness.ts` 会 `spawn` 仓库根目录的 `./webterm`，所以**改了 Go 代码
之后必须重新 `go build`**，否则 E2E 测的还是旧二进制。

改了前端也一样要 `npm run build` —— E2E 加载的是嵌进二进制里的产物，
不是 Vite dev server。

## 前端开发（热重载）

```bash
./webterm serve --dev &        # agent 在 8080
cd web && npm run dev          # Vite 在 5173，代理 /api /auth /ws 到 8080
```

浏览器开 `http://127.0.0.1:5173`。配对码在 agent 的 stdout 里，把它的
`/pair#<码>` 换成 5173 端口再打开。

## 提 PR 之前

见 [CLAUDE.md](../../CLAUDE.md) 的测试要求。要点：

- 改协议**必须先改** [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md)，
  再改 Go 与 TS 两侧，最后同步 `internal/protocol/testdata/vectors.json`（两侧单测都跑它）
- 改动触及协议、重连、输入或布局时，要在
  [`../70-testing/e2e-scenarios.md`](../70-testing/e2e-scenarios.md) 里加/改场景
- 涉及重连的改动必须跑通 **E2E-2a 字节级连续性**

## 发布

两个渠道，都由 [`.github/workflows/release.yml`](../../.github/workflows/release.yml) 出：

| 触发 | 产出 | 谁装到 |
|---|---|---|
| 合并进 `main` | 覆盖重建 `dev` 预发布（滚动） | `install.sh --channel dev` |
| 推 `v*` tag | 正式 release，`--generate-notes` | `install.sh`（默认 `latest`） |

两条都走 `make release`：交叉编译 amd64/arm64、断言静态链接（AC-8.1）与前端已嵌入（AC-8.2）。

**版本号来自 `git describe --tags --dirty --match 'v[0-9]*'`（Makefile），没有 `v*` tag
时退成 `dev-<短 sha>`。**

`--match` 不能省：`dev` 是个滚动的**轻量 tag**，正式 tag 会打在**同一个提交**上，
不带 `--match` 的 `git describe` 可能挑中它，正式构建就被标成 `webterm dev` ——
2026-09-14 第一次打 v0.1.0 就是这么发出去的（本机 describe 挑注解 tag、CI 挑了 `dev`，
所以本地怎么试都试不出来；那个 tag 已撤回）。工作流里那条「断言正式构建的版本号就是
tag」是它的看门人：版本号错了在别处一点都看不出来。

打正式 tag 之前先看 [`../90-roadmap/milestones.md`](../90-roadmap/milestones.md) 的出口标准：
自动化验不了的那几条（真机输入法、软键盘、真实网络切换、真 Let's Encrypt、PWA 安装）
在 [`../70-testing/manual-checklist.md`](../70-testing/manual-checklist.md) 里，得人去跑。
