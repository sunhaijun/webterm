# 会话管理

> 状态：Accepted。输出链路的决策见 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)。

## 职责边界

| 组件 | 职责 |
|---|---|
| `SessionManager` | `sid` 分配、会话表、上限控制、生命周期编排 |
| `Session` | 一个 PTY + 一个环形缓冲 + 一个终端模拟器 + 订阅者集合 |
| `vterm.Terminal` | 会话的终端模拟器（`internal/vterm`，包着 tuios.dev/vt）。吃全部 PTY 输出，出快照，导出 / 导入状态 |
| `Conn` | 一条 WebSocket 连接。持有它对各会话的订阅 |
| `inputState` | `(client_id, sid) → in_ack`。**挂在 Session 上而不是 Conn 上**，跨重连存活（协议 §5.4） |

**`Session` 不知道 WebSocket 的存在** —— 它只有一个"订阅者"接口。这让会话逻辑可以在没有网络的情况下单测（IT-session-*）。

```go
type Subscriber interface {
    // ClientID 返回订阅者所属标签页的 id。输入记账按 (client_id, sid) 走，
    // ack 只发给同一个 client。
    ClientID() string

    // Push 推送一段原始输出（OUTPUT 帧）。data 是可安全持有的拷贝。
    Push(sid uint16, seq uint64, data []byte)

    // Snapshot 推送一份快照（SNAPSHOT 帧，连接层按单帧上限拆分）。
    // seq 是快照对应的 out_seq；data 不计入 seq。
    Snapshot(sid uint16, seq uint64, data []byte)

    // Event 推送一条控制消息（*protocol.SessionUpdated、*protocol.Ack…）。
    Event(msg any)
}
```

三个方法**都必须非阻塞**（内部有界队列，满则自行断开）。

## 数据结构

```go
type SessionManager struct {
    mu       sync.RWMutex
    sessions map[uint16]*Session
    nextSID  uint16
    maxSess  int              // 默认 20
    cfg      Config
}

type Session struct {
    sid    uint16
    ptmx   *os.File           // PTY master
    cmd    *exec.Cmd

    mu         sync.RWMutex    // 保护以下所有字段
    name       string
    nameManual bool
    title      string          // 此刻采用的终端标题（ADR-0043）；"" = 不用标题
    titlePgrp  int             // 标题归属的前台进程组：最近一次写标题时在前台的那个
    cwd        string
    status     Status          // running | exited
    exitCode   *int
    cols, rows uint16
    ring       *ringbuf.Buffer // 默认 256 KiB，自带 base/head seq
    vt         vterm.Terminal  // 2000 行历史
    subs       map[Subscriber]struct{}

    inputQ   *inputQueue       // 有界 256 KiB，满则关连接（绝不阻塞，见下）
    inQueued map[string]uint64 // client_id → 已【接受入队】的累计字节数
    inAck    map[string]uint64 // client_id → 已【写入 PTY】的累计字节数
    done     chan struct{}
}
```

### `inQueued` 与 `inAck` 是两个数

- `inQueued` 用于校验 INPUT 帧的 seq 连续性 —— 拿 `inAck` 校验的话，客户端
  连着发两帧时第二帧会被误判成空洞（PTY 还没消费完第一帧）
- `inAck` 用于 `ack` 消息与 `welcome.resumed[].in_ack`
- 连接断开时 `DetachClient` 丢弃该 client 尚未写入 PTY 的入队数据，并把
  `inQueued` 回退到 `inAck`，让重连后的重发精确对齐（协议 §5.4）
- 两者都按 `client_id` 记账，**跨重连存活**，随会话销毁而释放

### 锁的规则

- **`ring.Append` 与 `vt.Write` 必须在同一把锁下、对同一段字节做。** 这样任何时刻模拟器吃到的字节数都等于 `ring.HeadSeq()`，快照的 `seq` 才能直接取 `HeadSeq()`。这是最容易出错的地方。
- **`subscribe` 的「判定增量 / 快照 + 取切片或生成快照 + 推送 + 加入订阅者集合」必须在同一把锁下完成。** 分开做，中间到达的一批输出要么被推两遍（重复），要么两边都漏（空洞）—— 而协议 §3 规定客户端遇到空洞**直接关连接**。这次推送是下面那条"不要在锁内推"的唯一例外：它是一次性的，而推送按契约本就非阻塞。
- **改列数的重排 + 生成快照 + 推给每个订阅者**也在同一把锁下（见 §改尺寸）。
- `Session.mu` 是读写锁：`readLoop` 写，订阅者列表读多写少。
- **实时输出、增量补齐、快照全部在锁内推给订阅者。** 出锁再推的话，一段已经算进快照的输出可能排到快照后面才到客户端，违反协议 §3 的连续性。这样做不会卡住 PTY 读取，因为 `Subscriber.Push` / `Snapshot` 按契约是非阻塞的（只入连接的写队列，满了就关连接）。

## `sid` 分配

`uint16` 递增，跳过仍在使用的值，回绕后从 1 重新找空位（0 保留为无效值）。

**不复用刚释放的 sid**（至少隔一轮回绕），避免"客户端还没处理完 sid=3 的关闭，新会话又叫 sid=3"这类竞态。

进程内的这个保证跨不过重启 —— 重启后 `sid` 从头分配，老客户端手里的 `sid` 可能指向一个毫不相干的新会话。所以 `SessionManager` 启动时生成一个随机 `instance_id`，放进 `welcome`；`hello` 里带的 `instance_id` 不符时，所有 `resume` 项一律判 `gone`（协议 §5.3）。

## 四个 goroutine

### `readLoop`

```
for {
    n, err := ptmx.Read(buf)          // buf 32 KiB
    if err != nil { break }           // EIO = shell 退出

    session.mu.Lock()
    seq := ring.Append(buf[:n])        // 返回本段起始 seq
    vt.Write(buf[:n])                  // 同一段字节，同一把锁
    vt.TakeResponses()                 // 模拟器的查询应答丢弃（查询由浏览器回答）
    subs := copySubs()
    data := copy(buf[:n])
    for _, s := range subs { s.Push(sid, seq, data) }   // 锁内：非阻塞，只入写队列
    session.mu.Unlock()

    emit(session.updated{head_seq})     // 未订阅的连接靠它判未读，连接层 1s 节流
}
```

**agent 不改写输出流**：`out_seq` 就是 PTY 输出的累计字节数（CLAUDE.md 不变式 ④）。

模拟器的开销：单核约 20 MB/s（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §背景）。交互程序的输出远低于它；`cat` 一个大文件会被限在这个速度。

### `writeLoop`

```
for item := range inputCh {                    // item = {clientID, data}
    n, err := ptmx.Write(item.data)
    if err != nil { break }
    session.addAck(item.clientID, sid, n)      // in_ack += n，节流后发 ack
}
```

`inputCh` 有界（256 KiB）。**入队必须是非阻塞的**：满了就回 `error{code:"input_stalled", sid}` 并关闭那条连接（协议 §5.6）。

**绝不能阻塞发送方** —— 发送方是 `Conn` 的读 goroutine，而一条 WebSocket 复用所有会话。一个不读 stdin 的前台程序（`sleep 1000`、某些 TUI）把 PTY 输入缓冲填满，就会顺着 `ptmx.Write` → `writeLoop` → `inputCh` 一路把整条连接的读循环卡死：ping/pong、`resize`、`session.create`、**其它会话的输入**全停，60 秒后 agent 还会把这条本来健康的连接判死。

关连接是无损的：client 重连后按 `in_ack` 重发（协议 §5.4）。

### `waitLoop`

```
err := cmd.Wait()
session.mu.Lock()
status = Exited
exitCode = extractExitCode(err)
session.mu.Unlock()
close(inputCh)                          // 停止接受输入
broadcast(session.updated{status:"exited", exit_code})
// ring 与模拟器保留，不释放（AC-4.5）
```

**`ring` 与模拟器在 `exited` 后保留**，直到用户显式 `session.close`。这是"构建失败了要回看报错"场景的支撑（AC-4.5）：切回、刷新都还能拿到快照。

### `cwdLoop`

运行中的会话每秒读一次工作目录与终端标题：

```
pgrp := ioctl(ptmx, TIOCGPGRP)          // PTY 的前台进程组
cwd  := readlink("/proc/<pgrp>/cwd")
title, writes := 模拟器的标题, 标题被写过几次
writes 变了 → titlePgrp = pgrp            // 标题归属于设它时在前台的进程组
s.title = (pgrp == titlePgrp && pgrp != shell 的 pid) ? clean(title) : ""
cwd 变了、或名字变了 → 一起广播 session.updated{cwd?, name?}
```

- 标题的规则见 [ADR-0043](../20-architecture/adr/0043-terminal-title-as-auto-name.md)：shell 在提示符时设的标题不用，程序退出回到目录名；用写入次数判断「设过」，新进程设了同样的标题也认得出

- 前台进程组的组长就是用户此刻在用的程序（shell、vim、claude…），它的目录就是用户认为"我在哪"
- 读失败（进程刚退出、权限）就跳过这一轮，不清空已有的 `cwd`
- 任何 shell 都适用，不需要 shell 配合。只构建 Linux（CI 只出 linux/amd64、linux/arm64），`/proc` 一定在
- ssh 出去之后显示的是本机 ssh 进程的目录 —— 远端的目录本来就不可知

## 订阅：增量还是快照

```
subscribe(sub, out_seq, cols, rows):
  锁内:
    列数与会话当前不同 → vt.Resize(cols, rows) → 快照
    否则 out_seq > 0 且 ring.Slice(out_seq) 成功 → 增量：Push(sid, out_seq, data)
         其余 → 快照：Snapshot(sid, ring.HeadSeq(), vt.Snapshot(2000))
         行数变了 → vt.Resize(cols, rows)
    加入订阅者集合
  锁外:
    尺寸变了 → TIOCSWINSZ
```

`hello.resume` 用同一个判定（不带尺寸）。快照包含当前屏、至多 2000 行历史、模式、画笔、滚动区、字符集、制表位、光标，以及解析到一半的序列（[协议 §5.2](../30-protocol/websocket-protocol.md)）。

**`TIOCSWINSZ` 必须在锁外、入队之后**：程序因 SIGWINCH 整屏重画的字节因此一定排在快照或增量之后。

## 改尺寸

```
Resize(cols, rows):
  锁内:
    列数变了 → vt.Resize → 生成快照（seq = HeadSeq）→ 推给每个订阅者
    只有行数变了 → vt.Resize
    记下 cols / rows
  锁外: TIOCSWINSZ（已退出的会话跳过）
```

列数变了要重发快照：两边各自重排的结果不一致，以 agent 的为准（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4）。只改行数不发 —— 手机每弹一次软键盘就改一次行数，每次重发上百 KiB、清掉浏览器的回看位置，代价太大。

## 生命周期

```
（不存在）──create──> running ──shell 退出──> exited ──close──> （销毁）
                        │
                        └──close──> SIGHUP ──2s──> SIGKILL ──> （销毁）
```

### 创建

```
1. 检查上限          → 超出返回 error{session_limit}
2. 校验参数          → cols/rows 必须 > 0 且 <= 1000
3. 解析 cwd          → 默认继承请求里的值，否则 home；必须存在且是目录
4. exec.Command(shell, "-l", "-i")    // 默认登录 shell；--no-login-shell 时只 "-i"
   环境：继承 agent 环境 + TERM=xterm-256color + WEBTERM_SESSION=<sid>
         + 备用屏兼容清单（AC-7.8）+ --session-env 的键值
   清理：BASH_ENV、ENV
5. pty.StartWithSize(cmd, &pty.Winsize{...})
   agent 的 oom_score_adj 是负数时，fork 前临时调到 0、Start 返回后调回（见下）
6. vt = vterm.New(cols, rows, 2000)
7. 起四个 goroutine
8. 落库无（会话不持久化，见 ADR-0005）
```

shell 按它自己的规则加载启动文件：登录 shell 读 profile 链，非登录的交互 shell 读 `~/.bashrc`。webterm 不注入任何东西。

**OOM 优先级（[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) §3）**：系统服务把 agent 设成 -900，会话要和 SSH 登录一样是 0。shell 必须在执行任何用户代码之前就是 0，否则 `~/.profile` 里起的常驻进程（ssh-agent 之类）会永久继承 -900。所以第 5 步持 `spawnMu`：先读自己的值 self；self < 0 就写 0，起 shell，再写回 self。调高不需要特权，调回 self 也不会低于下限。self ≥ 0（手动 `webterm serve`、用户服务）时什么都不做。调回必须在 `cmd.Start` 返回之后：Go 用 `CLONE_VM|CLONE_VFORK` 起子进程，exec 之前内核会把 `oom_score_adj` 的改动同步给它。

`TERM` 固定为 `xterm-256color`。不用 `xterm-kitty` 之类 —— 浏览器里的 xterm.js 的能力集与 `xterm-256color` 最匹配，查询也由它回答。

**备用屏兼容清单（AC-7.8，[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §1）**：把已知的全屏 AI CLI 拉回主屏，让它的输出变成追加流 —— 只有追加流才有 scrollback 可以往回拖。目前清单里只有一条 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。规则：

- **用户已经设过的同名变量不覆盖**（agent 自己的环境里有，或 `--session-env` 给了）—— 这是他的机器；
- `--session-env` 优先于清单，`--no-altscreen-compat` 整份关掉；
- 清单里**只放"把 TUI 拉回主屏"这一类变量**，任何改变程序行为的（模型、权限、遥测）一概不放；
- `TERM` 与 `WEBTERM_SESSION` 是 webterm 自己的口径（前者决定 xterm.js 那侧的能力匹配，后者是会话标识），**不接受覆盖** —— `--session-env` 写了这两个键会在解析时直接报错，`internal/session` 里还有第二道兜底。

这些是上游的私有开关，没有兼容承诺，所以必须能关、也必须能验证（[troubleshooting.md](../80-ops/troubleshooting.md)）。

### 关闭

```
running:
  1. syscall.Kill(-pgid, SIGHUP)     // bash 收到后会把 SIGHUP 转发给它的所有作业
  2. select { <-done | <-time.After(2s) }
  3. 超时 → killSession(sid, SIGKILL) + syscall.Kill(-pgid, SIGKILL)
  4. shell 退出后再 killSession(sid, SIGKILL) 扫一遍
  5. ptmx.Close()、释放 ring 与模拟器、从表里摘除
exited:
  直接执行 5
```

**光靠 `kill(-pgid)` 是不够的。** 交互式 bash 开着 job control，**每个作业都在自己的进程组里** —— `sleep 300 &` 的 pgid 不等于 shell 的 pgid，给 shell 的进程组发信号只能打到 shell 自己。

真正干活的是两条：

| 路径 | 靠什么 |
|---|---|
| 优雅（绝大多数情况） | SIGHUP 打到 shell，**bash 自己把 SIGHUP 转发给所有作业** |
| 兜底 | 按【会话】清扫：`pty.Start` 已 `setsid`，shell 的 sid == shell 的 pid，后代都继承它。扫 `/proc` 找 sid 相同的进程逐个 SIGKILL |

兜底那条不能省：宽限期内没退干净时 bash 已经没机会转发了，作业会变成孤儿继续跑。屏蔽了 SIGHUP 的作业（`trap "" HUP`）也只有这条路能收拾。

主动 `setsid` 脱离的进程（`nohup` / `setsid` / `systemd-run`）会逃掉 —— 那是用户明确的意图，符合预期。

## 自动命名（AC-4.4）

```go
func (s *Session) displayName() string {
    if s.nameManual { return s.name }
    if s.title != "" { return s.title }     // 前台程序设的终端标题（ADR-0043）
    if s.cwd == "" { return "shell" }
    if s.cwd == home { return "~" }
    if b := filepath.Base(s.cwd); b != "" && b != "/" { return b }
    return "/"
}
```

`cwdLoop` 每一轮：更新 `s.cwd` 与 `s.title`；目录变了或名字变了（`!nameManual` 时）就广播一条 `session.updated`，只带变了的字段。

**不做重名去重**（不加 `(2)` 后缀）—— 两个都在 `webterm` 目录下的会话本来就该同名。

## 上限与资源

| 项 | 默认 | 配置项 |
|---|---|---|
| 最大会话数 | 20 | `--max-sessions` |
| 最大并发连接数 | 16 | `--max-conns` |
| 每会话环形缓冲 | 256 KiB | `--ring-bytes` |
| 每会话模拟器历史 | 2000 行 | 常量（= 快照带的行数） |
| 每连接写队列 | 4 MiB | 常量 |
| 每会话输入队列 | 256 KiB | 常量 |
| 单帧上限 | 256 KiB | 协议常量，不可配 |
| PTY 读缓冲 | 32 KiB | 常量 |

内存上界 ≈ 20 ×（256 KiB 环形缓冲 + < 1 MiB 模拟器）+ 16 × 4 MiB（连接写队列）≈ 90 MiB。

**连接数必须有上限**：协议 §1 允许同设备开任意多标签页，而每条连接挂着一个 4 MiB 的写队列。超出时握手阶段直接拒绝（`503`），不进入协议层。

## 优雅关闭（`SIGTERM`）

```
1. 停止接受新的 WebSocket 连接
2. 向所有连接广播 notice{level:"warn", message:"agent 即将重启，所有会话将结束"}
3. 等 2 秒（让消息送出去）
4. 对所有会话执行关闭流程（SIGHUP → 2s → SIGKILL）
5. 关闭 store
6. 退出
```

第 2 步很重要：会话必然会丢（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)），至少要让用户知道**为什么**丢的，而不是看到一个莫名的重连失败。

## 热升级交接（`SIGUSR2` / `reexec`，[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）

升级**不走**上面的关闭流程。agent 原地 `exec` 新二进制，会话跟着进程一起活下来：

```
1. 预检：以子进程跑新二进制 `webterm handoff-check`，喂元数据快照；读不了 → 中止，服务照常
2. Freeze：拒新连接；给每个会话的 ptmx 设一个已过期的读 / 写 deadline，把阻塞在
   Read / Write 里的 readLoop / writeLoop 打断，两个循环停在安全点（喂完一段之后、
   pop 之前）。写了一半的输入把剩下的部分放回队首；cwdLoop 停
3. Export：持 s.mu 拍快照 —— 见下表；ring 导出为 (base_seq, 字节)，模拟器导出完整状态
   （带满 2000 行历史），输入队列导出未写完的条目
4. 广播 notice{level:"info"} 「正在热升级，会话保留，稍后自动重连」，关闭所有 WebSocket
5. 清 CLOEXEC，syscall.Exec(新二进制, serve …原参数… --handoff-fd N)
6. 新进程：Manager.Restore —— os.NewFile 接回 ptmx（O_NONBLOCK 在 fd 上，接回来就是
   可轮询的），os.FindProcess 接回 shell，ringbuf.Restore、模拟器导回状态，
   输入队列重新入队，四个 goroutine 重新起
```

任何一步失败（预检、memfd、exec 返回）→ `Thaw`：清 deadline、放行几个循环、恢复接受连接，日志 + notice 明说原因。**不自动退化成 restart**。

进快照的字段（`internal/handoff.Session`）就是 `Session` 结构体里"不能丢"的那部分：sid、ptmx fd、shell pid、createdAt、name / nameManual、title / titlePgrp（ADR-0043 §4）、cwd、status / exitCode、cols / rows、ring（base + 字节）、**模拟器状态**、inQueued / inAck、未写完的输入。**不进**快照的：订阅者 —— 连接会重建；agent 与 shell 的 `oom_score_adj` —— 前者随 execve 保留，后者本来就在 shell 进程上。已退出的会话（ring 与模拟器保留供回看）也交接，只是没有 fd 和 pid。

**交接前后同一会话生成的快照必须逐字节相等**，增量路径必须字节级连续（`TestHandoffByteLevelContinuity`）。

Manager 级别：`instance_id`（**不变**，客户端才能 `resume` 成 `ok`）、`nextSID`、代数 `generation`（每交接一次 +1，`webterm reload` 靠它判断新进程已接手）。

**冻结期间的不变式**：readLoop 停在一段字节喂完之后，所以 ring、模拟器与 `out_seq` 一致；writeLoop 停在 `pop` 之前，所以 `inAck` 与真正写进 PTY 的字节一致；都不再动，`Export` 拍到的就是一个自洽的切面。新增会话字段时先问"要不要进快照"。

控制 socket：`<data-dir>/run/agent.sock`（0600），一行 JSON 请求一行应答。`{"op":"status"}` → 版本、pid、generation、会话数、忙碌会话数（PTY 前台进程组不是 shell 自己，即有命令在跑）、`handoff: true`；`{"op":"reexec"}` → 触发上面的流程。`SIGUSR2` 等价。

## 崩溃残留清理

不需要清理 PTY 或进程 —— agent 死亡时 PTY master 关闭，shell 收到 `SIGHUP` 自行退出。webterm 不再生成任何临时文件（rcfile 已随 shell 集成删除）。
