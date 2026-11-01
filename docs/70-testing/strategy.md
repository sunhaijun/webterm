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
| Go 单测 | `go test` | 环形缓冲、终端模拟器封装（`internal/vterm`）、协议编解码、存储、认证逻辑 | < 10s |
| Go 集成 | `go test -tags=integration` | 真 PTY、真 SQLite、真 HTTP、真 WebSocket（进程内） | < 60s |
| 前端单测 | Vitest | seq 记账、重发队列、快照帧拼接、回放门、keymap 与附加键、文本输入页、退避；快照的屏幕级一致性（`@xterm/headless` 当裁判） | < 30s |
| E2E | Playwright | 真二进制 + 真浏览器，完整用户流程 | < 5min |

## 两条口径（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §10）

输出只有两条路，各有各的口径：

| 路径 | 口径 | 测试 |
|---|---|---|
| **增量**（断线短、切走短） | **字节级**：断开重连后的序列化结果与不断开逐字节一致 | 下面这一节、E2E-2 |
| **快照**（第一次打开、刷新、落出窗口、改列数） | **屏幕级**：xterm 先吃快照再吃之后的字节，逐格等于直接吃全部字节（字符、宽度、颜色、属性、光标、模式；软换行标记与 ADR-0026 列出的三处已知差异除外） | 下面的「屏幕级一致性」、E2E-30 / 31 / 36 |

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
| E2E-2c | 断开期间输出 > `ring_bytes` | 走快照路径：**屏幕级**一致（不要求字节级），后续输出正确 |
| E2E-2d | 连续快速断开 10 次 | 无累积错位 |
| E2E-3 | 断开期间在终端里输入 | 输入不丢、不重、顺序正确 |

E2E-2c 是唯一不要求字节一致的变体 —— 快照是 agent 重新画出来的画面，不是原始字节。它要求的是**画面**一致，且之后的输出接得上。

## 关键测试：屏幕级一致性（AC-2.21）★

快照那条路的看门人。做法照搬 2026-10-30 的离线试验：

```
1. 录制夹具：在伪终端里跑真实程序（claude 两种渲染方式、codex、vim、tmux、less、top、
   python、长日志、中文彩色输出），把原始输出字节录成 internal/vterm/testdata/rec/*.bin
2. Go 测试：对每段录制取一组截断点（均匀的 + 随机的，随机的会落在转义序列与多字节字符中间），
   在每个截断点用 internal/vterm 生成快照，写成 testdata 下的快照文件
3. Vitest：@xterm/headless（unicode11）当裁判
     参照 = 直接吃全部原始字节
     对照 = 新终端先吃截断点的快照、再吃截断点之后的原始字节
   逐格比较；写入前都先过流式 TextDecoder（xterm 写 Uint8Array 会在切开的 UTF-8 上丢字）
```

只比「看得见」的东西：空格的前景色归一、备用屏的软换行标记不比。ADR-0026 列出的三处已知差异（top 末格反白、SGR 53、关闭自动换行时光标 x 的记法）以白名单的形式写在测试里，新增差异必须先改 ADR。

## Go 单测清单

### `internal/ringbuf`（见 [`../50-backend/ring-buffer.md`](../50-backend/ring-buffer.md#必测用例)）

`UT-ring-1、2、5–10`。其中 `UT-ring-8`（模糊测试，随机 Append/Slice 序列断言不变式）是这个模块最有价值的测试 —— 环形缓冲的 bug 几乎全在边界。

### `internal/vterm`

- 同一段字节按任意分片喂入，快照逐字节相等（分片无关）
- `导出状态 → 导入` 前后快照逐字节相等（热升级用）
- 改列数后快照里的行宽等于新列数；只改行数时历史行不变
- 模拟器的查询应答被丢弃，不会写进 PTY

### `internal/protocol`

- 二进制帧编解码往返（含边界：`seq = 0`、`seq = MaxUint64`、`sid = 0`、`payload` 1 字节）
- 非法帧检测（长度不足、空 payload、超大 payload）
- 控制消息 JSON 往返
- **测试向量**：跑 `testdata/vectors.json`，与前端共用同一份 fixture（防实现漂移，协议 §9）

### `internal/store`

- 迁移幂等性：连续跑两次迁移，结果一致；`0003` 把老库里的 `commands` 表删掉
- 设备与配对的查询
- 权限：创建后文件是 `0600`

### `internal/auth`

- `UT-pair-1..4`：一次性、过期、熵、常数时间比较
- `UT-auth-1`：DB 存的是哈希不是原文

### `internal/session`：起 shell 时的 OOM 优先级（[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) §3）

- `UT-oom-1`：注入 `oom_score_adj` 的读写。self < 0 时顺序是「写 0 → 起 shell → 写回 self」，而且起 shell 时读到的是 0；self ≥ 0 时一次都不写；写 0 失败照样起 shell；写回失败只记日志，不报错

### `scripts/install.sh`

- `UT-install-unit`：`install.sh --print-unit` 打印的系统单元里有 `User=` / `Group=`（当前用户）、`OOMScoreAdjust=-900`、`OOMPolicy=continue`、`XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` 里的**字面 UID**（不是 `%U`）、`Wants=` / `After=user@<uid>.service`，`ExecStart` 带着端口参数；不联网、不需要 sudo
- `UT-install-embed`：二进制里嵌的就是 `scripts/install.sh`（逐字节相等）；`webterm install --help` 跑的是它（打出 install.sh 的用法）
- `UT-install-handover`：`--base-url file://…` 指向一个假二进制 + `SHA256SUMS`，install.sh 下载、校验之后调用 `<假二进制> install <原参数>`；假二进制不认 `install` 时脚本以「版本太旧」中止、不往下装。不联网、不需要 sudo
- `UT-install-default-addr`：不给 `--domain` 时，有 `install-state` 就沿用它（命令行参数覆盖同名项），没有就用公网 IP（`WEBTERM_PUBLIC_IP` 注入，不联网）；用 `--print-unit` 看 `ExecStart`
- `UT-install-config-sync`：已有配置文件时，重装改写 `domain` / 端口、端口回到默认值时删掉那一行，其它键原样保留

### `internal/agent`：IP 证书（[ADR-0042](../20-architecture/adr/0042-ip-address-certificates.md)）

- `UT-ipcert-1`：续期时刻 = `NotAfter - 有效期/3`；失败后一小时重试
- `UT-ipcert-2`：IPv6 字面量、非 IP 的地址不进 IP 模式 / 被拒绝；`IsIPAddress` 判定
- `UT-ipcert-3`：CA 目录里没有 `shortlived` → 报错里说清楚「这个 CA 不签 IP 证书」
- `UT-tls-staging-dir`：`--acme-staging` 的证书目录是 `certs-staging/`
- `UT-status-cert`：到期阈值 `min(10 天, 有效期/4)` —— 90 天证书剩 11 天不标黄、剩 9 天标黄；160 小时证书刚签下来不标黄、剩 30 小时标黄
- `UT-doctor-ip`：IP 模式不做 DNS 检查，公网 IP 不等于 `--domain` 时给出 NAT / 换 IP 的说明
- `UT-pair-wait`：`--wait` 在探针成功前不打印配对码；超时后提示看日志并照常打印

## Go 集成测试清单

用真 PTY + 真 SQLite + 进程内 HTTP server。

| ID | 内容 |
|---|---|
| `IT-session-1..5` | 多会话独立性、上限、自动命名（CWD 读 `/proc`）、退出保留缓冲与模拟器、关闭杀进程组 |
| `IT-resume-1..4` | 断线期间会话不暂停、增量回放不重发、输入重发不丢不重（`in_ack` 跨重连存活）、`instance_id` 不符判 `gone` |
| `IT-snapshot-1..3` | 落出窗口 / `out_seq == 0` 走快照且之后的 OUTPUT 从快照的 `seq` 接上；改列数向每个订阅者重发快照、只改行数不发；快照超过单帧上限时按 `MORE` 拆帧 |
| `IT-auth-1..4` | 路由认证矩阵（**含 `/ws`**）、Origin 校验、Cookie 属性、吊销即时生效 |
| `IT-pair-1..3` | 二维码输出、配对码不进日志、限速 |
| `IT-tls-1..3` | 用本地假 ACME CA（`internal/acmetest`）验证：真的签出证书并能握手；`--dev` 一次都不找 CA；挑战打不进来时给可读诊断（AC-1.13）。见下方「为什么不用 pebble」 |
| `IT-tls-4..6` | IP 模式（AC-1.16）：假 CA 收到的订单是 `ip` 标识 + `shortlived` profile，签出的证书带 IP SAN，**不带 SNI 的握手**能用 CA 根校验通过；重启读缓存、不再找 CA；有效期短到触发续期时会换一张新证书 |
| `IT-doctor-acme-1..2` | `doctor --acme` 的签发核心：假 CA 能验证时签出证书、临时目录用完删掉、端口释放；挑战打不进来时给可读诊断。域名与 IP 两种模式都跑 |
| `IT-privacy-1..2` | canary 字符串不出现在数据目录 / 日志中 |
| `IT-embed-1` | 删掉 `web/dist` 后二进制仍能提供前端（证明真的嵌入了） |
| `IT-resize-1` | `resize` 消息导致 PTY 的 `TIOCSWINSZ` 生效（在会话内跑 `stty size` 验证） |
| `IT-hb-1` | 60 秒无帧的连接被关闭 |
| `IT-queue-1` | 会话输入队列满 → `input_stalled`，入队非阻塞，其它会话不受影响（m1） |
| `IT-queue-2` | 连接写队列满 → 关闭该连接而不是阻塞 Session（m2，需要连接层） |
| `IT-sub-1` | 未订阅会话继续缓冲、继续喂给模拟器，`subscribe{out_seq}` 按增量或快照补齐 |
| `IT-handoff-1` | 热升级前后：增量路径字节级连续、同一会话的快照逐字节相等（`TestHandoffByteLevelContinuity`） |
| `IT-order-1` | 会话顺序（AC-4.13）：新建排最后、关闭去掉；`session.move` 挪到 `before` 前 / `null` 放最后、`before` 不存在当最后、`sid` 不存在回 `unknown_session`；成功后向所有连接广播 `session.order`（`req_id` 只在发起方）；`welcome.sessions[]` 按顺序；热升级后顺序不变 |
| `IT-oom-1` | 真 `/proc`、真 PTY、不需要 root：把子进程目标值调成「self + 100」（调高不需要特权，调回 self 不低于下限），并发起多个会话，每个 shell 的 `oom_score_adj` 都是目标值，agent 最后回到 self（ADR-0034 §3） |

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

**会话集成测试需要一个真 shell。** 测试跑一个受控的 `.bashrc`（通过 `HOME` 指向临时目录）以获得确定性。

## 前端单测清单（Vitest）

| ID | 内容 |
|---|---|
| `UT-seq-1` | `out_seq` 记账：连续帧、空洞检测、重复检测；SNAPSHOT 后 `out_seq` 跳到快照的 `seq` |
| `UT-snapshot-1` | SNAPSHOT 帧：`MORE` 拼接、收齐才应用、应用时 `reset` 并换新的 UTF-8 解码器 |
| `UT-utf8-1` | 输出按任意字节切开写入，中文标点（。…—“”）一个不丢（AC-2.23） |
| `UT-touch-1` | 触屏纵向拖转滚轮：每满一行高发一次、零头留到下一帧、方向、每次 touchmove 最多 3 次且超出的丢掉、10px 门槛与纵向占优、只在鼠标跟踪时转换并 `preventDefault`（AC-3.21） |
| `UT-input-1..3` | 文本输入页：回车语义（有内容 = 粘贴内容再回车 / 空回车发 `\r`）、composition 期间不发送、输入框属性 |
| `UT-textinput-2` | 文本页跟着会话走：每个会话各记页与草稿、新会话是键位页空草稿、关掉的会话被忘掉；切换会话时换草稿、焦点落到新会话的输入处、组字中先失焦再换（AC-3.22 / AC-4.8） |
| `UT-keymap-1` | 控制键映射表（对照 [`../40-frontend/keymap.md`](../40-frontend/keymap.md)） |
| `UT-look-1` | 外观默认值：xterm 默认字号 14px、字体是系统等宽栈；`Ctrl+Shift+,` 不是应用快捷键（AC-5.3） |
| `UT-close-1` | 关闭确认（AC-4.11，ADR-0038）：`running` 会话进 `closing` 而不发 `session.close`、`exited` 直接发；确认才发、取消不发；确认前先把焦点还给输入处；会话从列表里消失时 `closing` 清掉；关闭中的会话不发输入与 `resize`，它的 `unknown_session` 不弹 toast，本地没有的 sid 也不弹 |
| `UT-order-1` | 排序（AC-4.13，ADR-0040）：`moveBefore` 挪到某项前 / 最后、`before` 不存在当作最后；按指针位置算插入下标（越过中线才换位）；store 按 agent 给的顺序列出、新建排最后、`session.order` 整个替换（不认识的 sid 占位，晚到的会话落在那里）、`[n]` 跟着变 |
| `UT-swipe-1` | 行左滑（AC-4.12，ADR-0039）：10px 门槛与横向占优、位移夹在 0 到 −216、过半松手打开否则弹回、打开后右滑关上；下滑关 sheet 只在纵向占优时接管 |
| `UT-prefs-1` | 两项偏好（AC-5.3，ADR-0037）：主题默认跟随系统、`light` / `dark` 打上 `data-theme` 与 `color-scheme`、跟随系统时去掉；字号默认 14、只收 10–24 的整数、不合法回默认；`localStorage` 抛异常时用默认值且不抛；控制器改字号时所有实例一起换并补发 `resize`（容器没变也发），改主题时 xterm 主题跟着换 |
| `UT-reconnect-1` | 指数退避序列、抖动范围、`online` 事件立即重试 |
| `UT-hb-1` | 心跳间隔、pong 超时判死 |
| `UT-hb-2` | 自认在线时的即时探活：`online` / 页面可见 → 发 `ping`，2 秒无 `pong` → 关连接；`pong` 来了就不关（AC-2.20） |
| `UT-replay-2` | 回放门：用户输入事件派发期间的 `onData` 放行，`message` / 定时器里产生的在回放（增量补课、快照）中丢弃（AC-2.15） |
| `UT-raw-2` | 组字兜底复位：`blur` / `isComposing === false` 的 `keydown` 都把 `composing` 置回 false（AC-3.3） |
| `UT-resize-1` | resize 防抖 |
| `UT-fit-1` | 行列 = 可用尺寸 ÷ 稳定字符格尺寸，向下取整、最少 2 列 1 行；900px 宽的实测数（字符宽 8.4287px、可用 877px）得 104 列，与当前列数无关（AC-3.11） |
| `UT-name-1` | 会话自动命名规则（home → `~`、`/` → `/`、手动名优先） |
| 协议向量 | 跑 `internal/protocol/testdata/vectors.json`（与 Go 侧同一份） |

## E2E 清单

场景详情见 [`e2e-scenarios.md`](e2e-scenarios.md)。

## CI

两个 workflow（`.github/workflows/`）：

```yaml
ci.yml   # 【只在 PR 上跑】，一个 job：
  check:   gofmt · 文档链接 · go vet · 前端类型检查与单测
           · npm run build · go test ./... -race · 单二进制断言（AC-8.1/8.2）

e2e.yml  # 【CI 上不自动跑】：只留手动触发，见下
```

### 为什么是一个 job、为什么只在 PR 上跑

**Actions 按 job 分别向上取整计费。** 原来拆成五个 job（`go` / `web` / `static` /
`fmt` / `docs`），实测耗时 3.6 / 0.7 / 1.9 / 0.3 / 0.1 分钟 —— 光取整就白花两分钟，
而 `go` 与 `static` 还各自跑了一遍 `npm ci && npm run build`。合成一个 job 之后
构建一次，后面全部复用。

三条省法，都不换掉覆盖面：

1. **五个 job 合成一个**（取整浪费 + 重复构建）。便宜的检查排在前面 ——
   gofmt / 坏链 / 类型检查失败得越早，这一轮花掉的分钟数越少。
2. **只跑带 `-race` 的那一遍 `go test`**。原先普通跑一遍、带 race 再跑一遍，
   等于把整套测试跑了两次；`-race` 本来就把所有测试都跑了。这个项目 goroutine 很重
   （`session` / `wsconn` / `ringbuf`），该丢的是那遍重复，不是竞态检测。
3. **合并进 main 不再重跑**。`pull_request` 事件跑的本来就是 **merge ref**
   （main 与 PR 合并之后的树），main 上那一轮是同一棵树跑第二遍。
   `Release` 仍在 main 上照跑（dev 预发布不受影响），它自己也会做完整构建与嵌入断言。

另外两条防漏：`concurrency` 让同一分支上被顶掉的旧 run 立刻取消（连推几个 commit 时
不再并排烧）；`timeout-minutes` 给 job 封顶 —— Actions 的默认上限是 **360 分钟**，
一个卡住的 job 能把一个月的额度烧掉。

代价：**main 上没有独立的 CI 结论**。前提是 [CLAUDE.md](../../CLAUDE.md) 的
「不在 `main` 上直接开发」—— 所有改动都经 PR，PR 上跑的就是合并后的树。

**E2E 在 CI 上不跑，本地跑。** 一次约 6 分钟（装浏览器 + 构建 + 90 条用例），而 Actions 额度有限；
自动触发（合并进 main、PR 打标签）被取消，`e2e.yml` 只保留 `workflow_dispatch`：想要 CI 上的结论时
手动 `gh workflow run E2E --ref <分支>`，不点就一分钟都不花。

于是**本地 `make e2e` 全绿是每个 PR 的硬门槛**（[CLAUDE.md](../../CLAUDE.md)），没有 CI 兜底：

- 本地跑不动 E2E（缺库、没浏览器）就**不要提 PR**，先把环境修好 —— 见 [development.md §E2E 的两个坑](../80-ops/development.md#e2e-的两个坑)
- E2E 的前置是完整构建（`npm run build` → `go build`），这保证 `go:embed` 的路径是真的通的；本地跑的正是同一条路
- 放弃的是「只在 CI 环境才暴露的差异」这张安全网。历史上它抓到过两次：Go job 不构建前端 → `go:embed` 空目录 → `GET /` 503；浮层刚打开时焦点还在 body → Esc 关不掉（[ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)）。**代价是知情的**：往后这类差异要靠手动触发那一次去抓 —— 改动触及协议 / 重连 / 输入 / 布局、或改了 E2E 与构建本身时，值得手动跑一次再合
- `ci.yml` 的覆盖面不变：`go vet` / `go test -race` / 前端类型检查与单测 / 单二进制断言 / gofmt / 文档链接，每个 PR 的每次 push 都跑（合进 main 不重跑，理由见上）

## 覆盖率

不设硬性覆盖率门槛（会诱导写无意义的测试）。但以下模块**必须有近乎完全的分支覆盖**，review 时人工确认：

- `internal/ringbuf`
- `internal/vterm`（快照与状态导出）
- `internal/protocol`
- `web/src/conn`（seq 记账、快照帧、重发队列）

这四个是"断线续传"的全部实现。它们错了，产品的核心承诺就是假的。

## 手工测试清单

有些东西自动化不了 —— 真实输入法、真实软键盘、真实网络切换、真实证书签发。
完整清单见 [`manual-checklist.md`](manual-checklist.md)，**每次发布前跑一遍**。
