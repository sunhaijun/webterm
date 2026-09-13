# 会话管理

> 状态：Accepted

## 职责边界

| 组件 | 职责 |
|---|---|
| `SessionManager` | `sid` 分配、会话表、上限控制、生命周期编排 |
| `Session` | 一个 PTY + 一个环形缓冲 + 订阅者集合 + OSC 状态机 |
| `Conn` | 一条 WebSocket 连接。持有它对各会话的订阅 |
| `inputState` | `(client_id, sid) → in_ack`。**挂在 Session 上而不是 Conn 上**，跨重连存活（协议 §5.3） |

**`Session` 不知道 WebSocket 的存在** —— 它只有一个"订阅者"接口。这让会话逻辑可以在没有网络的情况下单测（IT-session-*）。

```go
type Subscriber interface {
    // ClientID 返回订阅者所属标签页的 id。输入记账按 (client_id, sid) 走，
    // ack 只发给同一个 client。
    ClientID() string

    // Push 推送一段输出。data 是可安全持有的拷贝。
    // attrPrefix 为 true 时连接层必须在 data 前插入 ESC[0m 并置 flags bit0 ——
    // 那 4 个字节不计入 seq。只会在 reset 回放的第一帧上出现。
    Push(sid uint16, seq uint64, data []byte, attrPrefix bool)

    // Event 推送一条控制消息（*protocol.Prompt、*protocol.CWD、
    // *protocol.CommandStart、*protocol.SessionUpdated…）。
    Event(msg any)
}
```

两个方法**都必须非阻塞**（内部有界队列，满则自行断开）。

## 数据结构

```go
type SessionManager struct {
    mu       sync.RWMutex
    sessions map[uint16]*Session
    nextSID  uint16
    maxSess  int              // 默认 20
    store    *store.Store
    cfg      Config
}

type Session struct {
    sid    uint16
    ptmx   *os.File           // PTY master
    cmd    *exec.Cmd
    rcPath string             // 临时 rcfile，销毁时删除

    mu        sync.RWMutex    // 保护以下所有字段
    name      string
    nameManual bool
    cwd       string
    status    Status          // running | exited
    exitCode  *int
    cols, rows uint16
    integration Integration   // pending | active | inactive
    ring      *ringbuf.Buffer // 内部自带 base/head seq
    subs      map[*Conn]struct{}

    osc      *oscparse.Parser  // 流式状态机
    pendCmd  string            // 待结算的命令原文
    curCmdID *int64            // 进行中的 commands 行主键
    curCmdAt time.Time

    inputQ   *inputQueue      // 有界 256 KiB，满则关连接（绝不阻塞，见下）
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
  `inQueued` 回退到 `inAck`，让重连后的重发精确对齐（协议 §5.3）
- 两者都按 `client_id` 记账，**跨重连存活**，随会话销毁而释放

### 锁的规则

- **`ring` 的内容与它的 seq 必须在同一把锁下更新。** 否则续传会算错切片位置 —— 这是最容易出错的地方。
- **`subscribe` 的「取切片 + 加入订阅者集合 + 推送补齐数据」三步必须在同一把锁下完成。** 前两步分开做，中间到达的一批输出要么被推送和切片各发一遍（重复），要么两边都漏（空洞）—— 而协议 §3 规定客户端遇到空洞**直接关连接**。补齐的那一次 `Push` 也必须在锁内，否则它可能排到后续实时 `Push` 的后面。这是下面那条"不要在锁内 Push"的唯一例外：它是一次性的，而 `Push` 按契约本就非阻塞。
- `Session.mu` 是读写锁：`readLoop` 写（append），订阅者列表读多写少。
- **不要在持有 `Session.mu` 时调用 `Subscriber.Push`。** 先在锁内拷出订阅者列表和数据切片，出锁再推。否则一个慢订阅者会卡住 PTY 读取。

## `sid` 分配

`uint16` 递增，跳过仍在使用的值，回绕后从 1 重新找空位（0 保留为无效值）。

**不复用刚释放的 sid**（至少隔一轮回绕），避免"客户端还没处理完 sid=3 的关闭，新会话又叫 sid=3"这类竞态。

进程内的这个保证跨不过重启 —— 重启后 `sid` 从头分配，老客户端手里的 `sid` 可能指向一个毫不相干的新会话。所以 `SessionManager` 启动时生成一个随机 `instance_id`，放进 `welcome`；`hello` 里带的 `instance_id` 不符时，所有 `resume` 项一律判 `gone`（协议 §5.2）。

## 三个 goroutine

### `readLoop`

```
for {
    n, err := ptmx.Read(buf)          // buf 32 KiB
    if err != nil { break }           // EIO = shell 退出
    clean, events := osc.Feed(buf[:n])  // 剥离 + 抽取事件

    session.mu.Lock()
    seq := ring.Append(clean)          // 返回本段起始 seq
    subs := copySubs()
    session.mu.Unlock()

    for _, s := range subs { s.Push(sid, seq, clean) }
    for _, ev := range events { handleEvent(ev) }   // 落库 + 广播
}
```

**关键顺序**（[ADR-0006](../20-architecture/adr/0006-agent-side-osc-parsing.md)）：`Feed` 剥离 → `Append` 计数。`out_seq` 永远等于 `clean` 字节的累计数。

`clean` 为空（这一批全是 OSC）时不 append、不推送，但仍处理事件。

### 粘性模式观察器（[ADR-0019](../20-architecture/adr/0019-altscreen-redraw-not-replay.md)）

`clean` 在进环形缓冲的同时喂给 `internal/termstate` 的观察器，与 `ring.Append` 在同一把锁下：

```
clean ──┬──> ring.Append(clean)      计数、缓冲
        └──> modes.Observe(clean)    只读，一个字节都不改
```

- **必须只读**。它不返回改写过的字节，也不吞任何东西 —— 一旦改写，[ADR-0006](../20-architecture/adr/0006-agent-side-osc-parsing.md) 的 `out_seq` 不变式就破了。单测直接断言"观察前后逐字节相等"
- **位置在剥离之后**：观察的必须是客户端将要看到的那份字节，否则模式判定与客户端的终端状态对不上
- 跟踪的是**粘性**模式（`?1049` 备用屏、`?1` DECCKM、鼠标、括号粘贴、Kitty 键盘栈、DECSTBM…）。完整表与"哪些绝不恢复"见 ADR-0019 §1
- 状态要**进热升级快照**（`handoff.Session.Modes`）：它推导不出来 —— 模式开关只在会话开头出现一次，环形缓冲早把它裁掉了，这正是 ADR-0019 的起因

### `writeLoop`

```
for item := range inputCh {                    // item = {clientID, data}
    n, err := ptmx.Write(item.data)
    if err != nil { break }
    session.addAck(item.clientID, sid, n)      // in_ack += n，节流后发 ack
}
```

`inputCh` 有界（256 KiB）。**入队必须是非阻塞的**：满了就回 `error{code:"input_stalled", sid}` 并关闭那条连接（协议 §5.5）。

**绝不能阻塞发送方** —— 发送方是 `Conn` 的读 goroutine，而一条 WebSocket 复用所有会话。一个不读 stdin 的前台程序（`sleep 1000`、某些 TUI）把 PTY 输入缓冲填满，就会顺着 `ptmx.Write` → `writeLoop` → `inputCh` 一路把整条连接的读循环卡死：ping/pong、`resize`、`session.create`、**其它会话的输入**全停，60 秒后 agent 还会把这条本来健康的连接判死。

关连接是无损的：client 重连后按 `in_ack` 重发（协议 §5.3）。

### `waitLoop`

```
err := cmd.Wait()
session.mu.Lock()
status = Exited
exitCode = extractExitCode(err)
session.mu.Unlock()
close(inputCh)                          // 停止接受输入
broadcast(session.closed / session.updated{status:"exited"})
// ring 保留，不释放（AC-4.5）
os.Remove(rcPath)
```

**`ring` 在 `exited` 后保留**，直到用户显式 `session.close`。这是"构建失败了要回看报错"场景的支撑（AC-4.5）。

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
3. 生成 rcfile       → shellinit.Render()，0600，运行时目录
4. 解析 cwd          → 默认继承请求里的值，否则 home；必须存在且是目录
5. exec.Command("bash", "--rcfile", rcPath, "-i")   // 长选项必须在短选项前
   环境：继承 agent 环境 + TERM=xterm-256color + WEBTERM_SESSION=<sid>
   清理：BASH_ENV、ENV
6. pty.StartWithSize(cmd, &pty.Winsize{...})
7. 起三个 goroutine
8. integration = pending，10 秒定时器
9. 落库无（会话不持久化，见 ADR-0005）
```

`TERM` 固定为 `xterm-256color`。不用 `xterm-kitty` 之类 —— xterm.js 的能力集与 `xterm-256color` 最匹配。

### 关闭

```
running:
  1. syscall.Kill(-pgid, SIGHUP)     // bash 收到后会把 SIGHUP 转发给它的所有作业
  2. select { <-done | <-time.After(2s) }
  3. 超时 → killSession(sid, SIGKILL) + syscall.Kill(-pgid, SIGKILL)
  4. shell 退出后再 killSession(sid, SIGKILL) 扫一遍
  5. ptmx.Close()、删 rcfile、释放 ring、从表里摘除
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
    if s.cwd == "" { return "shell" }
    if s.cwd == home { return "~" }
    if b := filepath.Base(s.cwd); b != "" && b != "/" { return b }
    return "/"
}
```

收到 `cwd` 事件时：更新 `s.cwd`；若 `!nameManual` 且名字发生变化，广播 `session.updated{name, cwd}`。

**不做重名去重**（不加 `(2)` 后缀）—— 两个都在 `webterm` 目录下的会话本来就该同名。

## 集成状态机（AC-7.6）

```
pending ──收到 OSC 1701;hello──> active
pending ──10 秒超时──────────> inactive
active  ──距上一个 133 标记超过 5 分钟──> inactive ──收到 133 标记──> active
```

"距上一个 133 标记超过 5 分钟"是个刻意宽松的启发。想精确判定"集成失效了"是做不到的：`readLoop` 看到大量输出但没有 133 标记，既可能是 `exec zsh`，也可能只是用户在跑一条长命令。

所以：**误判的代价必须低** —— `inactive` 只会让 UI 显示降级提示并停止自动切换模式，不影响终端可用性。再收到 133 标记立即转回 `active`。

## 上限与资源

| 项 | 默认 | 配置项 |
|---|---|---|
| 最大会话数 | 20 | `--max-sessions` |
| 最大并发连接数 | 16 | `--max-conns` |
| 每会话环形缓冲 | 1 MiB | `--ring-bytes` |
| 每连接写队列 | 4 MiB | `--conn-queue-bytes` |
| 每会话输入队列 | 256 KiB | 常量 |
| 单帧上限 | 256 KiB | 协议常量，不可配 |
| PTY 读缓冲 | 32 KiB | 常量 |

内存上界 = 20 × 1 MiB（环形缓冲）+ 16 × 4 MiB（连接写队列）≈ 84 MiB。

**连接数必须有上限**：协议 §1 允许同设备开任意多标签页，而每条连接挂着一个 4 MiB 的写队列。超出时握手阶段直接拒绝（`503`），不进入协议层。

## 优雅关闭（`SIGTERM`）

```
1. 停止接受新的 WebSocket 连接
2. 向所有连接广播 notice{level:"warn", message:"agent 即将重启，所有会话将结束"}
3. 等 2 秒（让消息送出去）
4. 对所有会话执行关闭流程（SIGHUP → 2s → SIGKILL）
5. 关闭 store，删除所有 rcfile
6. 退出
```

第 2 步很重要：会话必然会丢（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)），至少要让用户知道**为什么**丢的，而不是看到一个莫名的重连失败。

## 热升级交接（`SIGUSR2` / `reexec`，[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）

升级**不走**上面的关闭流程。agent 原地 `exec` 新二进制，会话跟着进程一起活下来：

```
1. 预检：以子进程跑新二进制 `webterm handoff-check`，喂元数据快照；读不了 → 中止，服务照常
2. Freeze：拒新连接；给每个会话的 ptmx 设一个已过期的读 / 写 deadline，把阻塞在
   Read / Write 里的 readLoop / writeLoop 打断，两个循环停在安全点（consume 之后、
   pop 之前）。写了一半的输入把剩下的部分放回队首
3. Export：持 s.mu 拍快照 —— 见下表；ring 导出为 (base_seq, 字节)，OSC 解析器导出中间态，
   输入队列导出未写完的条目
4. 广播 notice{level:"info"} 「正在热升级，会话保留，稍后自动重连」，关闭所有 WebSocket
5. 清 CLOEXEC，syscall.Exec(新二进制, serve …原参数… --handoff-fd N)
6. 新进程：Manager.Restore —— os.NewFile 接回 ptmx（O_NONBLOCK 在 fd 上，接回来就是
   可轮询的），os.FindProcess 接回 shell，ringbuf.Restore / oscparse.Restore，
   输入队列重新入队，三个 goroutine 重新起
```

任何一步失败（预检、memfd、exec 返回）→ `Thaw`：清 deadline、放行两个循环、恢复接受连接，日志 + notice 明说原因。**不自动退化成 restart**。

进快照的字段（`internal/handoff.Session`）就是 `Session` 结构体里"不能丢"的那部分：sid、ptmx fd、shell pid、rcPath、createdAt、name / nameManual、cwd、status / exitCode、cols / rows、integration / promptState / helloSeen / lastMark / lastInput、ring（base + 字节）、inQueued / inAck、OSC 解析器状态、pendCmd / curCmdID / curCmdAt、unmarkedRuns / unmarkedInput、未写完的输入。**不进**快照的：订阅者、探针（probe*）—— 连接会重建，探针重新武装。已退出的会话（ring 保留供回看）也交接，只是没有 fd 和 pid。

Manager 级别：`instance_id`（**不变**，客户端才能 `resume` 成 `ok`）、`nextSID`、代数 `generation`（每交接一次 +1，`webterm reload` 靠它判断新进程已接手）。

**冻结期间的不变式**：readLoop 停在 `consume` 之后，所以 ring 与 `out_seq` 一致；writeLoop 停在 `pop` 之前，所以 `inAck` 与真正写进 PTY 的字节一致；两者都不再动，`Export` 拍到的就是一个自洽的切面。新增会话字段时先问"要不要进快照"。

控制 socket：`<data-dir>/run/agent.sock`（0600），一行 JSON 请求一行应答。`{"op":"status"}` → 版本、pid、generation、会话数、忙碌数（`promptState == running`）、`handoff: true`；`{"op":"reexec"}` → 触发上面的流程。`SIGUSR2` 等价。

## 崩溃残留清理

agent 启动时：删除运行时目录下所有 `rc-*.bash` 文件（上次崩溃残留）。**带 `--handoff-fd` 启动时跳过**：那些 rcfile 属于正被交接过来的会话，由它们各自关闭时删除。

不需要清理 PTY 或进程 —— agent 死亡时 PTY master 关闭，shell 收到 `SIGHUP` 自行退出。

## 命令旁听（CommandObserver）

`Manager.SetCommandObserver` 挂一个旁听者，会话在 `133;C`（带 `1701;cmd` 文本与 cwd）、`133;D`、shell 退出和 `Close` 时同步回调 `CommandStarted / CommandEnded / SessionClosed`。回调在读循环上执行，**实现必须不阻塞**。目前唯一的旁听者是 `internal/transcript`（[ADR-0012](../20-architecture/adr/0012-ai-cli-conversation-first.md) β），它据此起停会话文件跟踪，并用 `Manager.Fanout` 把 `transcript` 消息发给所有连接。
