# ADR-0026 输出链路：agent 持有终端状态，浏览器只负责显示

状态：已接受（2026-10-30）· 与 [ADR-0025](0025-termux-style-ui.md) 在同一个 PR（m8）里落地

**取代**：

- [ADR-0019](0019-altscreen-redraw-not-replay.md)（备用屏不回放、改为重画）全部；
- [ADR-0024](0024-scrollback-layered-model.md) §2（预算写入、回看暂停跟随）、§3（客户端快照）、§4（备用屏滚动转滚轮）。§1（注入环境变量把 claude 拉回主屏）保留；
- [ADR-0006](0006-agent-side-osc-parsing.md)（agent 解析并剥离 OSC）与 [ADR-0010](0010-bash-rcfile-injection.md)（rcfile 注入 shell 集成）全部 —— 输出流不再被 agent 改写，shell 集成整体删除；
- [ADR-0025](0025-termux-style-ui.md) §10 里「保留 OSC 7」那一句，以及它的分步：m8 与 m9 合并成一个 PR。

**修订**：[ADR-0009](0009-hybrid-ws-framing.md)（混合帧）—— 新增 `SNAPSHOT` 帧类型，删掉 `ATTR_PREFIX` 标志；协议版本 1 → 2。

**不变**：增量续传的字节级连续性（AC-2.1 ★）、输入的 `in_seq` / `in_ack`（AC-2.4 / AC-2.12）、热升级不丢会话（[ADR-0016](0016-hot-reexec.md)，交接的内容变了）、输入绝不静默丢弃（[ADR-0020](0020-input-never-silently-dropped.md)，回放门保留）。

## 背景

### 用户的反馈

输出显示「几乎没法用」，而且不知道是哪里出的问题。

### 现在的模型：agent 存字节，浏览器存屏幕

agent 手里只有一段输出字节（环形缓冲），屏幕状态只在浏览器的 xterm 里。只要浏览器错过了连续的字节流（切走会话、断线超出窗口、刷新页面），就得把屏幕重新拼出来。为此先后打了四块补丁：

| 补丁 | 它在补什么 | 出处 |
|---|---|---|
| reset 回放：`ATTR_PREFIX` 帧清屏后重放整个窗口 | 窗口接不上浏览器手里那一屏 | 协议 §3 / §5 |
| 回放门：吞掉回放期间 xterm 对历史查询的自动应答 | 历史字节里的查询被重新回答，答案当成按键进了程序 | ADR-0020 |
| 备用屏重画：agent 跟踪粘性模式，抖窗口尺寸逼程序重画，300ms 兜底 | 字节窗口拼不出 vim / codex 的当前屏 | ADR-0019 |
| 客户端快照：刷新前存 IndexedDB | 刷新后浏览器什么都没有 | ADR-0024 §3（没合并，卡在协议层 bug 上） |

再加上性能层（按帧合并、回看暂停、64 KiB 预算写入）和 shell 集成（OSC 剥离、命令记录、集成状态机），任何一处出错，症状都长得一样：屏幕不对。没法归因。

根子是**模型错配**：备用屏程序的输出是「带模式的差分补丁」，字节窗口一滑过 `ESC[?1049h` 就拼不回来（[ADR-0019](0019-altscreen-redraw-not-replay.md) §背景）。Termux 和 tmux 没有这类问题，因为终端模拟器就在 PTY 旁边，屏幕状态始终在那里。

### 离线试验（2026-10-30）

候选里只有 [tuios.dev/vt](https://pkg.go.dev/tuios.dev/vt)（v0.3.2，MIT，charm `x/vt` 的分叉）能导出**完整状态**：它的 `snapshot.Capture` + `snapshot.Replay` 产出一段任何 xterm 都能吃的字节，带上终端模式、当前画笔、滚动区域、字符集、制表位、光标形状、未完成的软换行，以及**解析到一半的序列**。charm `x/vt`、`vt10x`、`midterm` 只能导出画面，没有进入实测。

**一致性**：17 段真实录制（claude 两种渲染方式、codex、vim、tmux、less、top、python、长日志、中文彩色输出）× 每段 23 个截断点（一部分故意切在转义序列和多字节字符中间）。以 xterm.js（headless 5.5，unicode11）为裁判，比较「xterm 直接吃原始字节」与「xterm 先吃快照再吃截断点之后的字节」，逐格比字符、宽度、颜色、属性、光标、模式：

- 完全一致：claude ×3、codex、vim、tmux、python、长日志、中文彩色输出、假的备用屏 TUI。
- 看得见的差异只有三处：
  - top 表头最后一格少了反白。程序写满整行后 `EL`，xterm.js 不擦最后一格，真 xterm / ghostty / tuios 都擦。这是 xterm.js 的偏差；
  - SGR 53（上划线）被 `Replay` 丢掉；
  - 关闭自动换行时，光标停在最后一列的记法（100 对 99），画面上看不出来。
- 只在重新排版时才显出来：less 这类程序改写过的行，软换行标记两边不同（xterm 记在下一行，tuios 记在上一行，`EL` 清的不是同一个）。
- **改尺寸之后两边各自重排，结果不一致**：改列数时历史里有上百行不同；只改行数时，有的场景差在对齐了几行空行，有的是程序没收到 SIGWINCH 时画面不同。

**性能**（Xeon E5-2697 v2 单核）：

| 项 | 数 |
|---|---|
| 解析吞吐 | 13–52 MB/s，混合约 22 MB/s。claude 输出只有 0.5–0.8 KB/s |
| 每会话常驻 | 带 5000 行历史 < 1 MiB；空会话 0.06 MiB |
| 快照（只要当前屏） | 0.3–3 KiB，< 0.5 ms |
| 快照（带 2000 行历史，普通内容） | 108–169 KiB，约 35 ms（上限见 §3） |
| 运行中的 claude / vim / tmux 的快照 | ≤ 4 KiB |
| 浏览器吃 2000 行快照 | 11–24 ms（对比现在重放 1 MiB 窗口 60–75 ms） |
| 二进制 | +1.8 MB，`CGO_ENABLED=0` 可编 |

**顺带发现的 bug**：xterm.js（5.5 与 6.0.0）的 `write(Uint8Array)`，在一个 3 字节 UTF-8 字符被切进两次写入、且第 2 字节是 `0x80`、切在第 2 字节之后时，会把整个字符丢掉。实测 `…` 和 `。`，同规律覆盖 U+2000–203F 与 U+3000–303F（`— “ ” ‘ ’ • 、「」《》`）。现在 PTY 的读边界和 64 KiB 预算写入器都会切开字符，所以中文输出偶尔吞标点，而字节级连续性测试测不出来。

## 决定

### 1. agent 给每个会话跑一个终端模拟器

- 用 `tuios.dev/vt`，**钉死 v0.3.2**，包在 `internal/vterm` 里。会话代码只通过它的几个方法访问：写入、改尺寸、生成快照、导出 / 导入状态（热升级用）。将来换实现只动这一个包。
- **所有 PTY 输出都喂给它**，不管有没有人订阅；和环形缓冲的追加**在同一把锁里**完成，所以任何时刻「模拟器吃到了第几个字节」都等于 `head_seq`。
- 历史 **2000 行**，和快照带的行数一致：存多了也发不出去。
- 模拟器自己生成的查询应答**丢掉**，查询仍由浏览器的 xterm 回答（见 §5）。

### 2. agent 不再改写输出流

shell 集成整体删除（§6），没有 OSC 要剥离了。**`seq` = 会话累计的 PTY 输出字节数**，一个字节都不改；`ATTR_PREFIX` 删除。

### 3. 订阅只有两条路：增量，或者快照

`hello.resume`（重连）与 `subscribe`（第一次打开、切回）走同一个判定：

| 条件 | 走哪条路 | 发什么 |
|---|---|---|
| 客户端的 `out_seq > 0`，且仍在环形缓冲窗口内（`base_seq ≤ out_seq ≤ head_seq`） | **增量**（`status: "ok"`） | 从 `out_seq` 起的原始字节（`OUTPUT` 帧），与现在相同 |
| 其余：第一次打开、刷新页面（`out_seq == 0`）、落出窗口 | **快照**（`status: "snapshot"`） | `SNAPSHOT` 帧：`seq` = 生成时的 `head_seq`，payload = `Replay` 字节（当前屏 + 至多 2000 行历史 + 模式 + 画笔 + 半截序列）；之后从 `seq` 起接 `OUTPUT` |

- **环形缓冲缩到 256 KiB**，只服务增量这一条路。积压超过 256 KiB 时，快照（≤ 170 KiB，浏览器 11–24 ms）比重放更小更快。缓冲按字节裁剪，不再找 `\n` 边界：落出窗口的客户端一律走快照，裁剪位置不再影响显示。
- **删除**：`reset` 消息、`redraw` 消息、`ATTR_PREFIX`、`internal/termstate`、抖窗口尺寸、300ms 兜底、`notifyReset`。
- **快照上限 1 MiB**：超过就按比例减少带的历史行数重新生成一次。离线试验里的「≤ 170 KiB」只对普通内容成立；宽终端（400 列）配上每 10 格换一次颜色的输出，满 2000 行实测约 1.6 MiB、生成 330 ms，1000 列约 4 MiB，已经顶到连接写队列上限。
- 快照超过单帧上限（256 KiB）时拆成多帧：同一个 `seq`，除最后一帧外都带 `FLAG_MORE`（bit0）。浏览器收齐再应用。
- 浏览器收到 `SNAPSHOT`：在写入流里写 RIS（`ESC c`）复位 → 换一个新的 UTF-8 解码器 → 写入快照 → `outSeq = seq`。**用写入流里的 RIS（`ESC c`）复位，不要调 `term.reset()`**：`reset()` 是同步的，不清写缓冲。列数一变 agent 立刻重发快照，此时还没解析完的旧输出会被画到复位之后、快照之前。RIS 和快照一起进写缓冲，顺序天然正确（xterm 自己在 `reset()` 的注释里也建议这种场合用 RIS）。不再提示「历史输出已截断」：快照就是完整的画面，没有被截断的东西。

### 4. 改列数以 agent 为准，重发一次快照

试验里两边各自重排的结果不一致，所以列数一变，就以 agent 的重排为唯一真相：

```
resize / subscribe 带来的 cols 与当前不同:
  锁内: 模拟器.Resize(cols, rows) → 生成快照（seq = head）→ 发给这个会话的每个订阅者
  锁外: TIOCSWINSZ（程序因 SIGWINCH 重画的字节排在快照之后）
只改行数:
  模拟器.Resize + TIOCSWINSZ，不发快照
```

只改行数不发快照，是为了软键盘：手机上每弹出、收起一次键盘都会改行数，每次重发上百 KiB、清掉浏览器的回看位置，代价太大。分歧只存在于「程序没有因 SIGWINCH 重画」的那部分画面，下一次快照（切回、重连、改列数）时收敛。

### 5. 查询仍由浏览器回答；回放门保留，范围变小

- agent 侧模拟器的应答一律丢弃。查询的回答者仍是浏览器里的 xterm.js：能力集（不支持 kitty 键盘协议、kitty 图形、sixel）和主题色都以它为准，程序探测到的就是它真正能显示的。让 agent 代答的话，tuios 会宣称支持这些能力，claude 就会改用浏览器不懂的编码。
- 浏览器写入 `SNAPSHOT` 和增量补课字节时，xterm 产生的自动应答**不进 PTY**，用户输入照常放行。判据仍是「谁产生的」，见 [input.md](../../40-frontend/input.md)。快照字节里没有查询，所以真正要防的只剩增量补课这一段。
- 代价不变：浏览器不在线时，程序发出的查询没人回答，要等它自己超时。今天就是这样。

### 6. 工作目录改读 `/proc`，shell 集成整体删除

- **CWD** = `readlink /proc/<前台进程组>/cwd`（对 PTY master 做 `TIOCGPGRP`），每个运行中的会话每秒读一次，变了就发 `session.updated{cwd, name}`。会话默认名仍是 CWD 的 basename（AC-4.4）。任何 shell 都能用，不再只认 bash。只构建 Linux（CI 只出 linux/amd64、linux/arm64），`/proc` 一定在。
- **「会话空闲」**（`--when-idle` 与控制 socket `status` 的忙碌数，[ADR-0016](0016-hot-reexec.md) §5）改为：PTY 的前台进程组就是 shell 自己（`TIOCGPGRP` == shell pid，和读 CWD 同一个调用）。原来靠提示符状态，集成失效时看不出忙不忙；现在任何 shell 都准。
- **shell 照常启动**：默认 `bash -l -i`（登录 shell，按 bash 自己的规则加载 profile 链）；`--no-login-shell` 时 `bash -i`（加载 `~/.bashrc`）。不再生成临时 rcfile。
- **删除**：`internal/shellinit`、`internal/oscparse`、`webterm shell-init` 子命令、`--no-shell-integration`、集成握手与状态机、按命令的活性探测、`prompt` / `command.start` / `command.end` / `cwd` 消息、会话字段 `integration` / `prompt_state` / `unmarked_input`；命令历史全套：`commands` 表（新迁移 DROP）、`/api/commands*`、`/api/fs`、`/api/settings`、`--no-history`、`internal/store/commands.go`。

### 7. 浏览器的输出路径：原生

```
每个会话: 一个 TextDecoder('utf-8')，stream 模式
OUTPUT 帧   → term.write(decoder.decode(payload, {stream: true}))
SNAPSHOT 帧 → decoder = new TextDecoder(); term.write('\x1bc' + decode(快照))   // RIS 在流内复位
```

- **先解码成字符串再写**，绕开 xterm 切开 UTF-8 时丢字的 bug。
- 删除：按帧合并、回看暂停跟随及其提示条、64 KiB 预算写入器、只给可见会话挂 WebGL（改用 xterm 默认的 DOM 渲染器）、自写的触屏滚动与惯性（改用 xterm 自带）、客户端快照。这些都等量过实际效果再说：量的口径是主线程长任务（这台机器没有 GPU），基线场景见 [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) E2E-37。
- 会话结束的本地提示行（ADR-0025 §6）直接 `term.write()`：xterm 的写入本来就是先进先出，不再需要「经过同一个写入器」。

### 8. 热升级交接模拟器状态

`handoff.Session` 里的粘性模式（`termstate`）换成模拟器状态：`snapshot.Capture`（带满 2000 行历史）导出，新进程 `snapshot.Apply` 导回。环形缓冲、`seq`、`in_ack` 照旧交接。交接前后同一会话生成的快照必须逐字节相等。

**从旧版本升级上来**（交接数据里没有模拟器状态）：新进程新建一个模拟器，把交接来的环形缓冲内容喂进去，尽力还原。这只发生在升级到本版本的那一次：缓冲窗口如果正好从备用屏程序的中间开始，那个会话的画面会错一次，下一次程序重画（或用户按一下键）就恢复。不为此中止升级 —— 会话活下来比这一次画面更重要。

旧版本 rcfile 给 bash 装的钩子在升级后仍然活着，会继续发 OSC 133 / 1701 / 7。它们现在原样透传给浏览器（xterm 会忽略），等那个 shell 退出、新会话起来就没有了。

### 9. 依赖与构建

`tuios.dev/vt v0.3.2` 及其依赖（`charmbracelet/x/ansi`、`ultraviolet` 等）全是纯 Go，`CGO_ENABLED=0` 构建通过。它的 `ghostty` build tag 会引入 cgo，我们不开。go.mod 里会出现 `go.mitchellh.com/libghostty` 的版本记录，但不参与编译。

### 10. 测试口径

| 路径 | 口径 | 测试 |
|---|---|---|
| 增量续传 | **字节级**：断线重连后的序列化结果与不断线逐字节一致（AC-2.1，不变） | E2E-2、`TestByteLevelContinuity` |
| 快照 | **屏幕级**：xterm 先吃快照再吃之后的字节，逐格等于直接吃全部字节（字符、宽度、颜色、属性、光标、模式；软换行标记与上面三处已知差异除外） | Vitest 跑录制夹具（xterm headless 当裁判）、E2E-30 / 31 / 36 |
| 热升级 | 交接前后快照逐字节相等；增量路径字节级连续 | `TestHandoffByteLevelContinuity` |

录制夹具（真实程序的原始字节）进 `internal/vterm/testdata/`，由 Go 测试生成各截断点的快照，Vitest 用 `@xterm/headless` 当裁判比对。

## 不变式（CLAUDE.md）随之改写

- **③ 输出不落盘**：落盘的只有设备与认证数据（命令历史已删）。
- **④ 序列号连续**：`seq` = 累计 PTY 输出字节数，agent 不改写输出流；`SNAPSHOT` 帧不计入 `seq`。

## 代价与取舍

- **新依赖**：tuios 很新（5 个版本，最新 2026-10-26，单人维护，v0 API 会变）。对策：钉版本，包一层 `internal/vterm`，只用五六个方法。
- **吞吐上限**：每个会话的输出被 agent 解析一遍，单核约 20 MB/s。`cat` 一个大文件会被限在这个速度（tmux 同理）；交互程序的输出远低于它。
- **三处可见差异**接受。top 那一格要等程序重画那一格才对。
- **只改行数时两边可能短暂不一致**，下一次快照收敛（§4）。
- **刷新页面**要下载一次快照（≤ 170 KiB），换来刷新后有 2000 行历史可翻（AC-5.14 由 agent 实现，不再需要浏览器存快照）。
- **失去 shell 集成**：没有命令记录、没有提示符状态。ssh 出去之后 CWD 显示的是本机 ssh 进程的目录，这一点和以前一样。
- **浏览器不在线时**，程序的终端查询没人回答（同今天）。

## 影响

### 删除的代码

| 位置 | 内容 |
|---|---|
| `internal/termstate` | 粘性模式跟踪 |
| `internal/oscparse`、`internal/shellinit` | OSC 剥离、rcfile |
| `internal/session` | 集成状态机、活性探测、命令记录、prompt、redraw、抖尺寸、兜底 |
| `internal/store/commands.go` 与对应迁移 | 命令历史 |
| `internal/agent` | `/api/commands*`、`/api/fs`、`/api/settings` |
| `cmd/webterm` | `shell-init` 子命令、`--no-shell-integration`、`--no-history` |
| `internal/protocol` | `reset` / `redraw` / `cwd` / `prompt` / `command.*` 消息，`ATTR_PREFIX` |
| `web/src` | `outputqueue`、`budgetwriter`、`interactive`、WebGL 挂载、客户端快照 |

### 文档

`websocket-protocol.md`（v2：`SNAPSHOT` 帧、订阅判定、删除的消息）、`http-api.md`、`ring-buffer.md`、`session-manager.md`、`storage-schema.md`、`privacy-history.md`、`shell-integration.md`（删除）、40-frontend 各篇、需求与验收标准、E2E 场景、CLAUDE.md 的不变式与测试要求。

### 验收标准与 E2E（编号不复用）

- **删除**：AC-2.7（`\n` 边界与 `ESC[0m` 前缀）、AC-2.16–2.19（备用屏重画与粘性模式）、AC-5.5、5.9、5.10、5.15、5.16、5.17，AC-6 全部，AC-7.1–7.7；E2E-37 的断言（改为只记录数值的基线）、E2E-38。
- **改写**：AC-2.3、2.6、2.11、2.14、2.15、4.4、5.14；E2E-2c、4、30、31、36。AC-7.8（会话环境）原地保留，AC-7 一节改名「会话环境」。
- **新增**：AC-2.21（快照屏幕级一致）、AC-2.22（改列数重发快照）、AC-2.23（中文标点切开不丢）；E2E-42（改列数重发快照）、E2E-43（切开的 UTF-8 不丢字）。
