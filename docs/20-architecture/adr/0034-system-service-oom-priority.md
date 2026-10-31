# ADR-0034 改成系统服务（以普通用户运行），agent 不再先于会话被 OOM 杀掉

状态：已接受（2026-10-31）。**修订** [ADR-0003](0003-no-tmux.md)「负面后果」与 [ADR-0016](0016-hot-reexec.md) §6「agent 自身崩溃仍丢会话」的适用范围；**推翻** [systemd.md](../../80-ops/systemd.md) 的「推荐形态：user service + setcap」和「系统级 service（不推荐）」。不变的部分：不用 tmux、agent 自己持有 PTY（ADR-0003）；agent 和会话都以普通用户运行（[threat-model](../../60-security/threat-model.md)）。

## 背景

有了 ADR-0016，会话只会在 agent 进程真正死掉时丢失。线上那台机器（t.awtto.com，3.8 GiB 内存加 2 GiB swap）从 2026-09-13 起，webterm.service 被内核 OOM killer 杀了 **9 次**，其中 10-30 一天就有 4 次。每次 agent 一死，所有会话的 shell 都收到 `SIGHUP`。

同一段时间里，用户放在 tmux 里的 claude / codex 一个都没丢。原因不是 tmux 更省内存，而是 OOM killer 挑它们的顺序排在后面：

| 进程 | 所在 cgroup | `oom_score_adj` |
|---|---|---|
| webterm（28 MB）和它的全部会话 | `user@1000.service/app.slice/webterm.service` | **200** |
| tmux 服务器（从 SSH 起的） | `session-21.scope` | 0 |
| tmux 的 pane（claude 等） | `user@1000.service/tmux-spawn-*.scope` | 0 |
| sshd | 系统服务 | -1000；fork 出的会话进程调回 0 |

OOM killer 的打分大致是「内存占比 × 1000 + `oom_score_adj`」。这台机器的内存加 swap 共 5.8 GiB，一个 300 MB 的 claude 只值 50 来分，而 200 的偏置直接压过它。结果是 **8 MB 的 agent 比 300 MB 的 claude 先被挑中**：10-30 那 4 次，webterm 整个 unit 的内存峰值只有 8–28 MB。

这个 200 来自 systemd 的设计。PID 1 把用户管理器（`user@.service`）设成 100，用户管理器再给自己的服务默认 `DefaultOOMScoreAdjust=200`。用意是内存不够时先杀用户服务，保住登录会话。webterm 作为用户服务，天生就在第一批里。

**而且这个值压不下去。** 内核规则：没有 `CAP_SYS_RESOURCE` 的进程可以随便调高 `oom_score_adj`，但调低时不能低于 `oom_score_adj_min`。这个下限等于最后一次**带特权**写入的值，fork 时继承。用户管理器的下限是 PID 1 写进去的 100，所以它下面的进程都低不过 100。实测：在 webterm 会话里从 200 调到 100 成功，调到 0 被拒。

**还有第二层问题。** 服务默认 `OOMPolicy=stop`。会话里任何一个进程被 OOM 杀掉，systemd 都会停掉整个 unit，所有会话一起死。会话里的进程全都继承了 200，大个的 claude、`go build`、Playwright 起的 Chromium 正是首选目标。

## 决策

### 1. 系统服务，以普通用户运行

单元放在 `/etc/systemd/system/webterm.service`，`User=` / `Group=` 写安装者本人。root 只在安装时用（写单元、setcap，这两步本来就要 sudo）。agent 和所有会话照旧以普通用户运行。

PID 1 在切换用户**之前**以 root 身份写 `oom_score_adj`，所以系统服务可以设任意值。这个值同时成为 agent 的下限，之后 agent 可以在下限以上自由地调高、调低。

### 2. agent 设 -900，会话设 0（照抄 sshd）

```ini
OOMScoreAdjust=-900
OOMPolicy=continue
```

- **agent 本身 -900**：排在所有普通进程之后才会被挑。不用 -1000（-1000 表示永远不杀），是为了 agent 真的泄漏时内核还有最后一个能杀的对象。正常的 agent 只有几十 MB：每个会话一份环形缓冲加一个模拟器，两者都有上限。
- **会话的 shell 起在 0**，和 tmux 的 pane、SSH 登录一样。内存吃紧时，会话里的程序和机器上其它交互进程公平竞争；用户服务（200）照旧先被杀。
- **`OOMPolicy=continue`**：会话里某个进程被 OOM 杀掉，只死它自己，unit 照常运行。agent 主进程被杀时（在 -900 下极少发生）unit 照样失败，由 `Restart=on-failure` 拉起，会话照样丢失。这个窄窗口和 ADR-0016 §3 一样对待。

### 3. 怎么让 shell 起在 0

shell 必须在执行**任何用户代码之前**就是 0。登录 shell 读 `~/.profile` 时可能起常驻进程（ssh-agent、keychain），它们一旦继承了 -900 就永远受保护。所以不能等 shell 起来之后再去写 `/proc/<pid>/oom_score_adj`。

做法是：fork 期间 agent 把自己临时调到 0，fork 完立刻调回去。

```
每次起 shell：
    加锁 spawnMu
    读自己的 oom_score_adj，记为 self
    self >= 0：什么都不做（手动跑 webterm serve、没有 sudo 时的用户服务），子进程照常继承
    self <  0：
        写 /proc/self/oom_score_adj = 0
        pty.StartWithSize(...)                 // 子进程在 fork 时继承 0
        写 /proc/self/oom_score_adj = self     // self 不低于下限，不需要特权
    解锁
```

- `oom_score_adj` 是进程级的，所有线程共享，Go 从哪个线程 fork 结果都一样。
- 调回必须等到子进程 exec 之后。Go 用 `CLONE_VM|CLONE_VFORK` 起子进程，内核会把 `oom_score_adj` 的改动同步给共享同一个 mm 的进程。`cmd.Start` 等子进程 exec 成功才返回，所以在它返回后调回是安全的。
- 窗口期以微秒计，期间 agent 自己是 0。窗口里碰巧 fork 出的其它子进程（比如 `handoff-check` 预检）也拿到 0，只是少受一点保护，无害。
- 调回失败（理论上不会发生）时记一条 warn 日志，agent 留在 0。这相当于退回到和 tmux 一样的待遇，服务不受影响。
- 热升级（ADR-0016）时，`oom_score_adj` 和它的下限都随 execve 保留，新进程启动时读到的仍是 -900；交接过来的 shell 早就是 0。所以这项**不进** `handoff.Session` 快照。
- 不加开关：agent 只看自己启动时拿到的值，负数才切换。

### 4. 用户 systemd 的环境要显式带上

系统服务不在用户管理器下面，拿不到它的环境变量。`HOME` / `USER` / `LOGNAME` / `SHELL` 由 systemd 按 `User=` 自动设置；`PATH`、`LANG` 和用户管理器里的一样，都来自系统默认值和 `/etc/locale.conf`。缺的是下面两个变量，没有它们，会话里的 `systemctl --user`、`journalctl --user` 以及走 D-Bus 的工具全都会失败：

```ini
Environment=XDG_RUNTIME_DIR=/run/user/<uid>
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus
Wants=user@<uid>.service
After=user@<uid>.service
```

`<uid>` 由 install.sh 写成字面值：系统单元里的 `%U` 是 PID 1 的 UID（0），不跟着 `User=` 变。`Wants=` / `After=` 保证 agent 起来之前 `/run/user/<uid>` 和用户总线已经就位。linger 照做，用户的其它用户服务也靠它。

用户管理器里通过 `environment.d` / `import-environment` 加进去的其它变量（这台机器上是 `SSH_AUTH_SOCK`）不会自动带过来。会话是登录 shell（`-l`），需要的变量写进 `~/.profile`。

### 5. 安装、升级与迁移

- **install.sh 只生成系统服务。** 写单元、`daemon-reload`、`enable`、启动和重启都用 `sudo systemctl`；探测服务状态用 `systemctl is-active webterm`，不需要特权。
- **热升级不需要 sudo。** `webterm reload` 走控制 socket（ADR-0016 §4），和单元归哪个 systemd 管无关。`sudo systemctl reload webterm` 效果相同。
- **已经装成用户服务的机器（迁移）。** 从用户管理器搬到 PID 1 等于换一个进程，热交接跨不过去，所以迁移那一次必然关掉所有会话。按 ADR-0016 §3「不静默退化成重启」的原则：
  - `webterm update` / install.sh 发现**用户服务正在跑**、又没带 `--force-restart` 时，只换二进制、重做 setcap，然后**照旧热升级这个用户服务**。单元文件不动（端口、域名的改动留到迁移时一起生效），最后打印迁移命令和代价；
  - 带了 `--force-restart`（本来就是「接受丢会话」的开关），或者用户服务**根本没在跑**（没有会话可丢）时执行迁移：停用并删除用户单元 → 写系统单元 → 启动 → 确认 active。顺序不能反，因为两边要抢同一个端口；
  - `webterm update` 默认带 `--if-newer`，版本没变时什么都不做。但待迁移又带了 `--force-restart` 时不算「没事可做」，照样迁移；
  - **在 webterm 会话里拒绝迁移。** 停用户服务会连跑着脚本的那个会话一起杀掉，迁移就断在半路：用户单元已经停了，系统单元还没写。脚本看 `/proc/self/cgroup` 是否在 `webterm.service` 里，在就报错、让用户从 SSH 重跑。不看 `$WEBTERM_SESSION`，因为 tmux 的 pane 会被搬进自己的 scope（停 webterm 杀不到），环境变量却可能是从 webterm 会话里带过去的。
- **没有 sudo 的机器**装不了服务：写 `/usr/local/bin` 和 setcap 本来就需要 sudo。systemd.md 保留一节手写用户服务的做法，讲清楚 200 这个优先级的代价，并建议在单元里写 `OOMScoreAdjust=100`（用户服务能到的最低值）和 `OOMPolicy=continue`。

### 6. 跟着要改的

- `webterm status`：先问系统单元，再问用户单元（照顾还没迁移的机器），最后才退化成探 `/healthz`。
- 提示文案里的 `systemctl --user` / `journalctl --user`（reload.go、update.go、status.go、install.sh）按实际的单元类型给出。
- 卸载：`sudo systemctl disable --now webterm`，然后删掉 `/etc/systemd/system/webterm.service`。

## 不做的

- **以 root 运行 agent。** 这样能拿到任意 `oom_score_adj`，但会话就成了 root shell。为了一个内存优先级把 root shell 挂到公网，说不过去。
- **改用户管理器的优先级**，也就是给 `user@<uid>.service` 加 drop-in 设成 0。这样 webterm 能和 tmux 打平，但改动的是用户的整个用户管理器，安装脚本不该越界去动。而且下限变成 0 之后，就做不到让 agent 比会话更晚被杀。
- **用 `AmbientCapabilities=` 取代 setcap。** 系统服务下这样能省掉「换二进制就得重做 setcap」，但 ambient capability 会被会话的 shell 继承：得在所有线程上清掉（`AllThreadsSyscall`），而且热升级后的新映像就没有它了。另议。
- **拆成前台进程和会话宿主两个进程**（ADR-0016 的路线 B）。宿主进程一样会被 OOM 挑中，病根是优先级，不是进程数。
- **承诺 OOM 下会话不丢。** 内存真耗尽时，内核照样会杀会话里最大的进程，在 tmux 里也一样。这里保证的只是：不再发生「一个小 agent 被挑中，所有会话陪葬」。

## 代价与取舍

- 安装、迁移、卸载都要 sudo。升级本来就要，因为要重做 setcap。
- 安装脚本多出一条迁移路径，只在已有用户服务时走；等存量机器都迁完就可以删。
- 会话进程不属于任何 logind 会话（`loginctl` 里看不到）。现在的用户服务也是这样，不算新代价。
- 日志从 `journalctl --user -u webterm` 变成 `journalctl -u webterm`。agent 自己的日志普通用户照样能读，systemd 的生命周期记录要 sudo（见下面的实测）。

### 实测（2026-10-31，Debian 13 / systemd 257 / tmux 3.5a）

用 `sudo systemd-run` 起临时系统单元，属性与 §2、§4 相同（`User=sun`、`OOMScoreAdjust=-900`，带上两个环境变量），再加 `MemoryMax=300M` 制造 OOM：

| 项目 | 结果 |
|---|---|
| `HOME` / `USER` / `LOGNAME` / `SHELL` | 按 `User=` 自动设置；`PATH`、`LANG` 与用户管理器一致 |
| §3 的切换 | 启动值 -900；调到 0 → fork 的子进程是 0；**无特权调回 -900 成功**；调到 -950 被拒 |
| 会话里的 `systemctl --user` / `journalctl --user` | 正常 |
| 会话里的 `systemd-run --user --scope` | 正常，进程被搬进 `user@1000.service/app.slice/run-*.scope` |
| tmux 的 pane | 照常被搬进 `tmux-spawn-*.scope`；**tmux 服务器留在 webterm 的 cgroup**，所以在 webterm 里新起的 tmux 服务器仍会随 webterm 一起停（与现在相同） |
| 子进程要 400M、被 OOM 杀 | `OOMPolicy=continue`：子进程 137，主进程活着；`OOMPolicy=stop`：主进程被一起杀掉 |
| 普通用户 `journalctl -u webterm` | 读得到 **agent 自己写的日志**（按 UID 落进用户自己的日志文件）；**读不到 systemd 关于这个 unit 的记录**（「被 OOM 杀」「Failed with result」），那些在系统日志里，要 `sudo` 或 `adm` 组 |

最后一条是相对用户服务的一处退步：用户服务的生命周期记录在用户日志里，普通用户就能看。排障文档要写清楚「查有没有被 OOM 杀」要用 `sudo journalctl -u webterm`，或者用 `systemctl show webterm -p NRestarts`（不需要特权）。

## 影响

- **文档**
  - [systemd.md](../../80-ops/systemd.md)：推荐形态改成系统服务，给出完整单元；新增「OOM 优先级」一节（本 ADR 背景的精简版）；删除「系统级 service（不推荐）」；用户服务降为「没有 sudo 时」；状态、日志、升级命令全部改写。
  - [install.md](../../80-ops/install.md)：脚本步骤描述、升级（含迁移）、卸载、「关于 sudo」。
  - [troubleshooting.md](../../80-ops/troubleshooting.md)：「升级/重启后会话全没了」补上 OOM 和排查方法（journal 里的 `oom-kill`），并说明还没迁移的机器为什么仍会遇到。
  - ADR-0003「负面后果」、ADR-0016 §6 最后一条：加上指向本 ADR 的注。
  - [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md)：新增 AC-2.24（AC-2.16–2.23 已被 `feat/40-no-settings` 占用）——「**agent 不先于会话被 OOM 杀掉**：按 install.sh 装出的服务，agent 进程 `oom_score_adj = -900`；会话 shell 及其子进程起始为 0，包括登录 shell 读 profile 期间起的进程；热升级后两者都不变；会话内的进程被 OOM 杀掉时，unit 不停，其它会话不受影响」。
  - [manual-checklist.md](../../70-testing/manual-checklist.md)：新增一项，迁移后用 `stress-ng --vm` 制造内存压力，看被杀的是谁。这一项要 root，还会扰动整台机器，不进自动化。
- **代码**
  - `deploy/webterm.service` 改成系统单元模板。
  - `scripts/install.sh`：生成系统单元、改用 `sudo systemctl`、迁移路径、状态探测；新增 `--print-unit`，只打印将要写入的单元。
  - `internal/session`：起 shell 时切换 `oom_score_adj`（§3）。
  - `cmd/webterm`：status.go / reload.go / update.go 的探测逻辑和文案。
- **测试**
  - UT-oom-1：§3 的切换逻辑，注入 `/proc` 的读写。验证 self < 0 时顺序是 0 → start → self；self ≥ 0 时完全不碰；调回失败只记日志、不报错；并发起会话时串行。
  - IT-oom-1：真 `/proc`、真 PTY，**不需要 root**。目标值在测试里调成「self + 100」：调高从来不需要特权，调回 self 也不会低于下限，所以 CI 和本机都能跑。起若干个会话（含并发），断言每个 shell 拿到的是目标值、agent 最后回到 self。-900 / 0 这对真实取值靠上面的实测和手工清单。
  - install.sh：Go 测试调 `install.sh --print-unit`，断言 `User=`、`OOMScoreAdjust=-900`、`OOMPolicy=continue`、`XDG_RUNTIME_DIR` 里是字面 UID、`After=user@<uid>.service` 这几行。
