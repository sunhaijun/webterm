# 输入

> 状态：Accepted。决策见 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)（Termux 式界面）与
> [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)（输入绝不静默丢弃）。
> 键到字节的映射与应用快捷键见 [`keymap.md`](keymap.md)。

## 三样东西

| | 是什么 | 什么时候用 |
|---|---|---|
| **终端直输** | 点终端，软键盘或实体键盘的每个键经 xterm 直送 PTY | 默认。敲命令、操作 vim / less / claude |
| **附加键** | 终端下方两行固定键，补软键盘上没有的键 | 手机、触屏 Pad |
| **文本输入页** | 附加键区的第二页：一个原生 `textarea`，写好一段再送出去 | 打长段中文、给 claude 写 prompt |

没有「输入模式」。终端直输永远可用，文本输入页只是附加键区的另一页，两者不互斥：文本页开着时点终端，键盘照样进终端。

---

## 附加键（AC-3.18）

### 何时显示

`compact` 形态恒显示；`wide` 形态在 `pointer: coarse` 时显示（[layout.md](layout.md#形态ac-518)）。鼠标键盘设备上没有附加键，也就没有文本输入页。

### 键位

默认键位就是 Termux 的默认键位，**静态**：不随前台程序、提示符状态、shell 集成状态变。

```
左列   键区（7 列 × 2 行，等宽，不横滑）
┌────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ [3]│ ESC  │  /   │  -   │ HOME │  ↑   │ END  │ PGUP │
├────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ ✎  │ TAB  │ CTRL │ ALT  │  ←   │  ↓   │  →   │ PGDN │
└────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```

| 位置 | testid | 动作 |
|---|---|---|
| 会话按钮 `[3]`（仅 `compact`） | `open-sessions` | 圆角方框里写会话数；打开会话抽屉；有未读时带小红点（[session-ux.md](session-ux.md)） |
| ✎ | `toggle-text` | 键位页 ⇄ 文本输入页 |
| ESC / | - | `key-Escape` `key-Slash` `key-Minus` | 发对应字节 |
| HOME ↑ END PGUP | `key-Home` `key-ArrowUp` `key-End` `key-PageUp` | 同上 |
| TAB | `key-Tab` | 同上 |
| CTRL ALT | `key-Ctrl` `key-Alt` | 粘滞修饰（见下） |
| ← ↓ → PGDN | `key-ArrowLeft` `key-ArrowDown` `key-ArrowRight` `key-PageDown` | 发对应字节 |

`wide` 上左列只有 ✎，跨两行。

### 行为

- **几何**：两行，每行 40px；左列 44px；键区 7 列等宽。393px 宽下每个键约 50px，**任何宽度下都不横向滚动**。
- **抬起时才发**：`pointerdown` 只做 `preventDefault`（保焦点），字节在 `pointerup` 时发。这样在键区上横滑切页不会误按键；CTRL / ALT 也要等抬起才分得清是点（激活）还是长按（锁定）。
- **不抢焦点**：所有键在 `pointerdown` 时 `preventDefault`。按附加键不会让软键盘收起或弹出，终端或文本框的焦点不动。
- **编码与实体键盘一致**：字节表见 [keymap.md](keymap.md)。方向键与 `HOME` / `END` 跟随应用光标键模式（DECCKM，`term.modes.applicationCursorKeysMode`）：开着时发 `ESC O A` / `ESC O H`，关着时发 `ESC [ A` / `ESC [ H`。
- **发往哪里**：附加键的字节走与按键相同的 `onData` 出口（计入 `inputStats`，受回放门判定），目标是当前会话的 PTY。文本输入页开着时也一样 —— 附加键永远是终端键，不编辑文本框。
- **CTRL / ALT 粘滞**：
  1. 点一下 → 激活（`data-sticky="armed"`），只对**下一个键**生效；
  2. 下一个键可以来自附加键，也可以来自软键盘：终端 `onData` 出口上，激活时把单个字符按 [keymap.md](keymap.md) 的组合规则变换（CTRL：`a`–`z` → `0x01`–`0x1a` 等；ALT：前缀 `ESC`），然后自动取消激活；
  3. **长按** → 锁定（`data-sticky="locked"`），连续多次组合（`Ctrl+C` 之后接 `Ctrl+D`），再点一下解锁；
  4. 激活与锁定都用 `--accent` 高亮，一眼看得出下一个键会变成什么。

---

## 文本输入页（AC-3.19）

### 切换

- 点 ✎（可见入口），或在键区上左右滑动（加速路径，横向位移 > 40px 且横向占优）。
- 两页在同一个 80px 的槽里，切换时**终端行列数不变**、不发 `resize`。
- 切到文本页时聚焦 `textarea`（在点击处理函数里聚焦，iOS 才会弹键盘）；切回键位页时，如果 `textarea` 有焦点就把焦点还给终端。

### 文本框

```html
<textarea data-testid="textinput" rows="2" enterkeyhint="send"></textarea>
```

- 两行高，是一个**四边都有边框的输入框**：与附加键槽四周留 6px、1px 边框、圆角，聚焦时边框变成强调色。整个框落在 80px 的槽内，下边框不会被视口或软键盘切掉。内容多了在框内滚动。
- 字号 ≥ 16px（iOS 聚焦时不放大页面）。
- `autocorrect` / `autocapitalize` / `spellcheck` 必须关（AC-3.10），否则移动端会把 `cd` 改成 `Cd`、把 `ls` 改成 `is`。**必须用 `setAttribute` 设，不能只写在 JSX 里**：Chrome 把 `autocorrect` 实现成了 boolean IDL 属性，框架看到同名属性存在就会去赋属性 —— `"off"` 是个真值，反射出来的 attribute 变成 `autocorrect="on"`，正好是反的。E2E 断言的是 attribute 的实际值。

### 回车

| 情形 | 行为 |
|---|---|
| 正在组字（`event.isComposing`，或 `keyCode === 229`） | 不处理，交给输入法选词 |
| 文本框有内容 | 把内容发出去**并回车**；清空文本框 |
| 文本框是空的 | 发一个 `\r` |

- 回车**永远不在文本框里插入换行**（`keydown` 上 `preventDefault`）。
- 写完一段按回车就提交，不用再空按一次（[ADR-0027](../20-architecture/adr/0027-text-page-enter-submits.md)）。
- 发完**留在文本页、保持焦点**，可以接着发下一段。要回终端，点 ✎ 或点终端。

### 怎么发

有内容时分两步，都在回车 `keydown` 的派发里同步发生：

1. `term.paste(text)`：换行转 `CR`；对端开了括号粘贴（`?2004h`）就包上 `ESC[200~ … ESC[201~`，没开就原样发；
2. `term.input('\r', true)`：单独键入一个回车。

两步都走 `onData`：`inputStats` 照常计数，回放门按「谁产生的」照常判定（此刻正在派发的是回车的 `keydown`，在用户输入事件表里）。

文本页的发送**不吃 CTRL / ALT 粘滞**：内容和回车原样发出，激活状态也不消耗。粘滞修饰是给「下一个键」的；ALT 激活时回车会变成 `ESC \r`，claude 把它当换行，prompt 就提交不了。

**`\r` 不能拼在内容后面一起键入。** claude 收到一次写入的「长内容 + `\r`」，会把整块当成粘贴，`\r` 被吞掉，prompt 留在输入框里不提交（实测数据见 ADR-0027）。括号粘贴的结束标记把内容和回车在字节上分开，不需要靠时间间隔。

---

## 终端直输

### 点按终端（AC-3.20）

| 条件 | 点一下 |
|---|---|
| 前台程序开了鼠标跟踪（`term.modes.mouseTrackingMode !== 'none'`） | 交给 xterm：浏览器把触摸合成为 `mousedown` / `mouseup`，xterm 按程序要的协议上报点击 |
| 没开 | **切换软键盘**：终端的 helper textarea 有焦点就 `blur()`（键盘收起），没有就 `focus()`（键盘弹出） |

- `focus()` 必须发生在这次触摸的处理函数里（`touchend` / `click`），iOS 只允许在用户手势里弹键盘。
- 「点一下」= 位移 < 10px 且时长 < 300ms。拖动是滚动（[layout.md](layout.md#渲染adr-0026-7)），不算点。
- 鼠标设备上点终端就是普通的 xterm 点击（聚焦 + 选择），没有切换语义。

### 纵向拖（AC-3.21）

| 条件 | 纵向拖 |
|---|---|
| 前台程序开了鼠标跟踪 | **转成滚轮**：手指每移动一行高发一次（[ADR-0032](../20-architecture/adr/0032-drag-wheel-per-row.md)）。滚轮是给 xterm 派发的合成 `WheelEvent`（`deltaMode = DOM_DELTA_LINE`、`deltaY = ±1`、坐标取手指位置），xterm 按程序要的协议上报。手指向下 = 滚轮向上（看更早的） |
| 没开，主屏 | xterm 自带的触摸滚动，翻 scrollback |
| 没开，备用屏 | 不动，**不**发方向键（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §4） |

- 程序一次滚几行由程序自己定：tmux 的 copy-mode 一次 5 行，手指拖一行内容走 5 行；想逐行动就把 copy-mode 的滚轮改成 `-N 1`（[ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md) §3）。
- 一次 `touchmove` 最多发 3 次滚轮，超出的丢掉、不攒到下一帧（快速一甩不往 PTY 灌，ADR-0029）。
- 全屏程序最细一行一跳，内容比手指晚一个网络往返。
- 位移满 10px（「点一下」的门槛）且纵向占优才算拖；从起点开始累计，前 10px 不丢。横向拖什么都不做。
- 转换期间 `touchmove` 调 `preventDefault`，浏览器不再原生滚一次。
- xterm 5.5 自己不做这件事：程序开了鼠标跟踪时它的触摸处理直接返回，浏览器也不会把拖动合成成滚轮（[ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md)）。
- 合成的 `wheel` 在派发期间就是 `window.event`，在用户输入事件表里，回放期间照常放行（见下文 §回放门只吞自动应答）。

### IME 处理（AC-3.3）

xterm 用屏幕外的 helper textarea 承载输入法（不能 `display:none`，否则拿不到 composition 事件）。`RawIme`（`web/src/keys/raw.ts`）在它上面补三件事：

```
compositionstart  → composing = true，在光标位置显示内联预览浮层（ime-preview）
compositionupdate → 更新浮层内容（不发送任何字节）
compositionend    → composing = false，隐藏浮层，把 event.data 一次性发送
```

**`keydown` 处理器必须在 `composing === true` 时全部 return。** 这是中文能用的关键。

**`composing` 必须有兜底复位**（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)）。`composing` 只有一个正常出口 —— `compositionend`，可它不保证来：切输入法、切窗口、候选框被系统吞掉，都可能让组字停在半路。`composing` 卡在 true 的后果是**这个会话的终端输入永久失效**，用户没有任何线索。两条兜底：

| 兜底 | 为什么它成立 |
|---|---|
| `blur` | 元素都不是焦点了，组字不可能还在进行 |
| 捕获阶段的 `keydown`，`isComposing === false` 且 `keyCode !== 229` | 浏览器自己说了这不是组字中的按键 |

`keydown` 那条**必须挂在捕获阶段**：`RawIme` 是在 `term.open()` 之后构造的，冒泡阶段的监听排在 xterm 自己的 `keydown` 后面，等它跑完这一下按键已经被当成"组字中"丢掉了。

`blur` 复位不提交任何文本：`blur` 时拿不到组字内容。如果浏览器随后仍然补发了 `compositionend`，它照常提交，不会丢字。

内联预览浮层绝对定位到 xterm 的当前光标屏幕坐标（`buffer.active.cursorX/cursorY` × cell 尺寸），显示未提交的组字内容 + 下划线。

### 直接插入的文本（AC-3.14）

组字只是一半。另一半是**软键盘不经过组字、直接插进来的字符** —— iOS 中文键盘的全角标点就走这条路。**这条路 xterm 5.5 接不住**：

| xterm 的路 | 它的条件 | iOS 全角标点为什么落空 |
|---|---|---|
| `keydown` 直接取字 | `keyCode >= 48 && key.length === 1` | iOS 对这类直接插入报 **`keyCode` 0** |
| `input` 事件兜底 | `!composed \|\| !_keyDownSeen` | keydown 已经发生过，整个 `input` 事件被忽略 |
| `keyCode === 229` 的 textarea 差量 | 只在 `keyCode` 恰好是 229 时 | 不是 229 就不走这条 |

于是「逗号进不去、句号能进」：同一个键盘上，一个键报 `keyCode` 0（两头都不接），另一个报 229（走差量路，能进）。

**做法：非组字的 `insertText` 由 `RawIme` 自己接管**：在 `beforeinput` 上发送并 `preventDefault`。`preventDefault` 让字符**不落进 textarea**，xterm 的 `input` 路径与 229 差量路径就都不会再发一遍。三个不碰：组字中（`isComposing`）、`inputType` 不是 `insertText` 的、xterm 在 `keydown` 里已经处理掉的键（它会 `preventDefault`，根本没有 `beforeinput`）。

**去重只压「已经被另一条路送出去」的那一次，而且是一次性的。** 会重复发送的只有两种情形：

- `compositionend` 提交之后，WebKit 会补发一次同内容的 `insertText`；
- xterm 的 `_keyPress` 处理掉一个可打印字符时不 `preventDefault`，那个字符还会插进 textarea 再发一次 `beforeinput`。

只有这两处才「布防」（记下刚发出去的文字 + 时刻），**压住一次之后立刻撤防**。`beforeinput` 自己发出去的**不布防**：紧跟着的同一个字符是用户又敲了一下，不是补发。按「内容 + 时间窗口」判重，连打两下同一个字符第二下会被**静默吃掉** —— 那正是 ADR-0020 明令禁止的。时间窗口（120ms）只是布防的保质期。

### 粘贴

实体键盘上的粘贴（`Ctrl+Shift+V` / `Cmd+V`）走 xterm 的 `onPaste`，按对端模式包括号粘贴。触屏上的粘贴入口在第 4 步的长按菜单里（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §5）。

### 回放门只吞自动应答（AC-2.15 / ADR-0020）

`onData` 上有两种东西，必须分开：

| 来源 | 什么时候发生 | 该不该进 PTY |
|---|---|---|
| xterm 对历史查询（DSR / DA / `CSI ?u`）的**自动应答** | 同步发生在 `term.write()` 的解析里 | 回放期间**不该** —— 那不是用户输入 |
| 用户的按键、粘贴、附加键、文本输入页 | 同步发生在一次 DOM 输入事件的派发里 | **永远该** |

判据是**谁产生的**，不是**什么时候**。按"会话此刻是否在回放"一刀切，就会把用户正在敲的字一起吞掉。

什么算回放（[协议 §5.3](../30-protocol/websocket-protocol.md)）：写入 SNAPSHOT 的那一次，以及 `out_seq` 追到 `catchup_to` 之前的增量补课。快照里没有查询序列，真正会触发自动应答的只有增量补课那一段；但写快照时也照样开着回放门，规则只有一条，不分情况。

做法（`web/src/term/userinput.ts`）：问浏览器**此刻正在派发哪个事件** —— `window.event`。它在派发期间指向当前事件，派发一结束就恢复：

```
onData(data):
  window.event?.type ∈ 用户输入事件表  → 放行（哪怕在回放）
  否则 replayDepth > 0                  → 丢弃（自动应答）
  否则                                  → 放行
```

用户输入事件表：`keydown` `keypress` `beforeinput` `input` `paste` `compositionend` `compositionupdate` `pointerdown` `pointerup` `mousedown` `mouseup` `mousemove` `wheel`。`pointer*` 是附加键：它在一次指针事件的派发里同步调 `term.input()`；`mouse*` / `wheel` 是程序开了鼠标跟踪时 xterm 的鼠标上报，同样在那次事件的派发里同步产生 `onData`。不在表里的话，回放期间按的附加键、点的终端会被当成自动应答吞掉。新增一种能产生 `onData` 的用户交互时，想让它在回放期间也放行，就把它的事件类型加进这张表；不加也只是回到"回放期间丢弃"，不会更糟。

**不自己开时间窗**：xterm 对它处理掉的按键 `preventDefault + stopPropagation`，冒泡阶段根本收不到，窗口只能靠定时器关，而定时器任务与网络任务之间没有顺序保证。顺带覆盖两个容易漏的情形：xterm 在用户刚输入过之后会**同步**解析下一次 `write()`（那次 write 发起自 WebSocket 的 `message` 事件，`type` 不在表里，照样拦住）；`setTimeout` 驱动的分片解析没有正在派发的事件，也拦住。

---

## 排障：输入死在哪一段（AC-3.17）

输入路径按段留了计数，生产构建里也在：

```js
__webterm.inputStats()
// {
//   keydown:  {n: 12, agoMs: 900},    // 捕获阶段看到的 keydown：键真的按下了
//   toTerm:   {n: 12, agoMs: 900},    // 其中焦点确实在终端的 helper textarea 上
//   data:     {n: 12, agoMs: 900},    // xterm 吐出的 onData（用户输入那一路，含附加键与文本页）
//   sent:     {n: 12, agoMs: 890},    // 发给 agent 的 INPUT 帧
//   gated:    0,                      // 被回放门丢掉的（自动应答，不该有用户按键）
//   unackedBytes: 0,                  // 发了但 agent 还没 ack —— 涨着不降就是没送到
//   focus: 'xterm-helper-textarea',
//   verdict: '四段都通：输入已经送达 agent'
// }
```

**按段读**，断点一眼可见（`verdict` 就是按这张表算的）：

| 现象 | 断点 | 多半是 |
|---|---|---|
| `keydown` 不涨 | 键没进页面 | 焦点在别的窗口 / 系统层吃掉了 |
| `keydown` 涨、`toTerm` 不涨 | 焦点不在终端 | 切会话 / 关浮层之后焦点落回 `body`（AC-4.8）；或焦点在文本输入页（那是对的，看 `focus` 字段） |
| `toTerm` 涨、`data` 不涨 | 卡在 xterm | 组字状态没复位（`composing` 恒真）；或按键被应用级快捷键拦下 |
| `data` 涨、`sent` 不涨 | 没发出去 | 回放门（看 `gated`）、或连接已断且离线队列满 |
| `sent` 涨、`unackedBytes` 一直不降 | agent 没确认 | 僵尸连接（AC-2.20）、或 agent 那一侧 PTY 写不进 |
| **四段全通，程序还是没反应** | **不在 webterm 内** | 前台程序自己不读 stdin，或者它进了别的模式 —— 最常见的是 **tmux 的 copy-mode**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §4），出口是 `q` / `Esc` |

两条口径：

- **计数按「最近一次发生」比，不按总量比**。总量是页面打开以来的累计，卡住之前的成功输入会把它撑满；`agoMs`（距今多久）才能说明"最近这一下走到哪儿断了"。
- **`keydown` 必须挂在捕获阶段**。xterm 处理掉的键会 `preventDefault + stopPropagation`，冒泡阶段根本收不到。
