# ADR-0029 触屏纵向拖：程序开了鼠标跟踪时转成滚轮

> **§1「跟手靠自动标定」被 [ADR-0032](0032-drag-wheel-per-row.md) 去掉**：用户试用后觉得太慢，改成手指每移动一行高发一次滚轮，程序一次滚几行由程序自己定。§2 的转换条件、方向、发法、节流不变。「后果」里的实测表不再成立。

状态：已接受（2026-10-31）。**修订 [ADR-0025](0025-termux-style-ui.md) §5 手势表里「纵向拖」一行**，新增 AC-3.21。主屏的触摸滚动、备用屏没开鼠标跟踪时不动（[ADR-0024](0024-scrollback-layered-model.md) §4）、「点一下」的语义都不变。

## 背景

ADR-0025 §5 写的是：纵向拖用 xterm 自带的触摸滚动，「备用屏程序开了鼠标跟踪时由 xterm 按它的规则上报」。

这条假设不成立。xterm 5.5 的触摸处理在 `areMouseEventsActive` 时直接返回，什么都不做（`Terminal.ts` 的 `touchstart` / `touchmove`）。浏览器只会把「点一下」合成为鼠标事件，拖动既不合成 `mousemove`，也不合成 `wheel`。

结果是：程序一开鼠标跟踪，手机上纵向拖就**完全没反应**。用户的 claude / codex 跑在 tmux 里，`~/.tmux.conf` 里是 `set -g mouse on`，tmux 就会开鼠标跟踪；claude 自己也开（2.1.316 实测：1000 / 1002 / 1003 / 1006）。tmux 和 claude 都在备用屏，历史在它们自己手里，网页终端里没有可翻的东西，唯一的翻法就是把滚轮交给它们。

[ADR-0024](0024-scrollback-layered-model.md) §4 规划过同一个机制（按行累积、合成 `WheelEvent` 交给 xterm 编码），但从没落地，后来随 [ADR-0026](0026-agent-holds-terminal-state.md) 一起被取代；m8 之前的界面在手机上同样翻不动。

2026-10-31 实测（Pixel 5 设备描述，真 tmux 开 `mouse on`）：手指纵向拖 300px，发出的 INPUT 帧 **0 个**，tmux 没进 copy-mode。同样的 tmux 在桌面上用滚轮，xterm 发出 `ESC[<64;…M`，tmux 进 copy-mode、往回翻。

## 决策

**前台程序开了鼠标跟踪时，终端上的纵向拖由 webterm 转成滚轮，并且跟手：手指移动多少行，内容就移动多少行。**

### 1. 跟手靠自动标定

一次滚轮滚几行由程序决定：tmux 的 copy-mode 5 行，vim 3 行（`mousescroll`），claude 随渲染器而变。webterm 事先不知道，所以每次拖动先量一下：

1. 拖动成立的那一刻发**第一次**滚轮，同时记下屏幕上的各行；
2. 之后每次写入解析完（`onWriteParsed`），比较屏幕：在发之前只出现过一次的非空行，统计它们各自挪了几行，票数最多、且至少 2 行对得上的位移就是**步长**；
3. 量到之前（最多 300ms），手指的位移先攒着不发，免得几次滚轮叠在一起量错；
4. 量到之后，手指每移动「步长 × 行高」发一次滚轮。量到的那一下已经挪走的一步从攒着的位移里扣掉。

**量不到的那一下当作没挪，下一下再量。** tmux 开着 `mouse on` 时，第一次滚轮只是把 pane 推进 copy-mode，屏幕不挪（实测 3.5a 的根绑定：`copy-mode -e`）；真正滚动从第二下开始。一次拖动最多量 2 次，还量不到（到顶了没得滚、程序不按行滚）就按已知步长走，不再等。

步长记在会话的终端上，下一次拖动照样先量。从没量到过时按 3 行算。

程序换了步长（切到另一个 tmux pane、vim 里改了 `mousescroll`），下一次拖动就量到新值。

### 2. 其余

- **方向**跟触摸滚动一致：手指往下拖 = 看更早的内容 = 滚轮向上（`deltaY < 0`）。
- **怎么发**：每一次给 xterm 的根元素派发一个合成的 `WheelEvent`，带 `deltaMode = DOM_DELTA_LINE`、`deltaY = ±1`，坐标取手指当前位置。xterm 的鼠标跟踪路径里，一个滚轮事件就是一次上报，编码（X10 / SGR / URXVT）和行列都由 xterm 按程序要的协议算。tmux 按坐标决定滚哪个 pane。
- **节流**（取自 ADR-0024 §4）：一次 `touchmove` 最多发 3 次，超出的丢掉，不攒到下一帧。浏览器把 `touchmove` 合并到每帧一个，所以约等于每帧最多 3 次，防止快速一甩往 PTY 灌一串上报。
- **什么时候算拖**：位移满 10px（和「点一下」的门槛一致），并且纵向占优。横向拖不做任何事（不变）。
- **不让浏览器再滚一次**：转换期间对 `touchmove` 调 `preventDefault`。
- **用户输入**：合成的 `wheel` 在派发期间就是 `window.event`，它在用户输入事件表里（`userinput.ts`），回放期间照常放行。

没开鼠标跟踪时一切照旧：主屏走 xterm 自带的触摸滚动翻 scrollback；备用屏不动，**不**发方向键（ADR-0024 §4）。

### 3. 做不到的

- **不会像素级平滑。** 全屏程序的屏幕是程序一帧一帧画的，最细一行一跳；步长是 5 的程序就是 5 行一跳，只是平均速度和手指一致。tmux 里想逐行动，把 copy-mode 的滚轮改成一次 1 行，标定自动跟上：

  ```
  bind -T copy-mode    WheelUpPane   select-pane \; send -X -N 1 scroll-up
  bind -T copy-mode    WheelDownPane select-pane \; send -X -N 1 scroll-down
  bind -T copy-mode-vi WheelUpPane   select-pane \; send -X -N 1 scroll-up
  bind -T copy-mode-vi WheelDownPane select-pane \; send -X -N 1 scroll-down
  ```

  代价是桌面滚轮在 tmux 里也变成一格 1 行。
- **慢一个网络往返。** 每一步都要等服务器上的程序重画回来，内容比手指晚一个 RTT。

## 不采纳的方案

- **自己按协议编码滚轮上报。** 要处理 X10 / SGR / URXVT 三种编码、1000 / 1002 / 1003 三种模式，还要算行列，xterm 里全都有。合成 `WheelEvent` 交给它，以后 xterm 改了编码细节也跟着走。
- **照 Termux 手指每移动一行高发一次。** 程序一次滚 N 行，内容就比手指快 N 倍：tmux 里拖一行高走 5 行，拖一下就滚出去一大截，不跟手。
- **固定按 3 行一次换算**（多数程序的默认值）。tmux 默认 5 行，还是快 1.7 倍；claude 换渲染器步长就变。
- **每一次滚轮都量。** 量一次要等一个往返，期间不能发下一次，滚动速度就被网络延迟卡死（一个往返一行）。每次拖动量一次就够：拖动过程中程序不会变。
- **惯性滑动（fling）。** ADR-0026 §7 删掉了自写的惯性，量过实际效果再说。
- **ADR-0024 §4 的「滚动交给了程序，打不进字就按 Esc / q」提示。** 它的判据是「转发过滚轮之后，用户打字而屏幕 1.5 秒内一个字节都没变」。可是 tmux 的 copy-mode 里按键会移动光标、重画屏幕，判据恰恰在最需要它的 tmux 里不触发。tmux 进 copy-mode 时右上角本来就有 `[12/340]` 位置指示。界面上也不再加说明文字（[ADR-0028](0028-settings-without-notes.md)）。

## 后果

实测（Pixel 5 设备描述，真 tmux 3.5a 开 `mouse on`，`seq 1 300` 之后读 copy-mode 的 `[N/300]`，手指每步隔 30ms）：

| | 手指向下拖 10 行 | 再拖两次 | 往回拖 6 行 |
|---|---|---|---|
| tmux 默认（一次 5 行） | 翻 10 行（第一下进 copy-mode，第二下量到 5） | 各 10 行 | 回 5 行 |
| 绑定改成 `-N 1` | 翻 10 行 | 各 10 行 | 回 6 行 |
| 对照：每行一次（Termux） | 50 行 | | |

- 手机上 tmux（`mouse on`）、claude、htop、`less --mouse` 这类程序能用手指翻了。
- tmux 的 copy-mode 坑（[troubleshooting.md](../../80-ops/troubleshooting.md) §在 tmux 里突然打不进字）在手机上也会出现：pane 里的程序没开鼠标跟踪时，拖一下就把 pane 推进 copy-mode。出口照旧是 `q` / `Esc`。这和桌面滚轮是同一件事。
- 每次拖动开头有一次标定：第一次滚轮立刻发，第二次要等程序重画回来（一个往返，最多 300ms）。
- 新增 AC-3.21、E2E-44、UT-touch-1，手工清单加真机 tmux / claude 两条。
