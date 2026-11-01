# E2E 场景清单

> 状态：Accepted
>
> Playwright。每个场景标注它验证的验收标准。**改动触及协议、重连、输入或布局时必须更新这份清单**（[CLAUDE.md](../../CLAUDE.md)）。

## 测试夹具

### 启动

```
1. go build 出真二进制（含 go:embed 的前端产物）
2. webterm serve --dev --data-dir <临时目录> --max-sessions 5
   默认 ring-bytes（256 KiB）—— 断线窗口内的输出不会溢出，增量路径的字节级比较才稳定
   只有 E2E-2c / E2E-4 / E2E-30 / E2E-31 用 --ring-bytes 65536 单独起一个实例，让快照路径可测
3. 从 stdout 抓配对 URL
4. Playwright 打开 URL，完成配对
```

### 确定性输出脚本

`e2e/fixtures/emit.sh` —— 产生固定内容的输出，用于字节级比较：

```bash
#!/bin/bash
# 用法: emit.sh <总行数> [每行延迟ms] [mono]
# 内容含：ANSI 颜色、CJK 宽字符、超长行；每行以 `line NNNNN` 开头、147 列宽
# mono：整段只有开头一个 SGR、结尾一个复位（一段跨越很多帧的同色文本）
```

必须**完全确定性**（不含时间戳、不含随机数、不含主机名、不含 `$PWD`），否则字节级比较无意义。

两条容易踩的坑：

- **完成标记必须只出现在输出里。** 写 `echo EMIT-DONE` 的话，被回显的命令行本身就含这个串，等待条件会在命令刚敲完时就满足 —— 测的是回显不是输出。用 `printf 'EMIT-%s\n' DONE`。
- **要测断线期间的行为，就得给每行加延迟**，让输出跨越整个断线窗口。不加的话几千行可能在你把线掐掉之前就全送到了。

### 断开 WebSocket 的手段

```ts
// 方式一：路由层面切断（首选）。装一个可控的中继，随时掐断、随时恢复。
const net = await installWSControl(page)   // e2e/harness.ts
await net.goOffline()
net.goOnline()

// 方式二：CDP 模拟离线
const cdp = await context.newCDPSession(page)
await cdp.send('Network.emulateNetworkConditions', { offline: true, ... })
```

**方式一是首选。** CDP 的 offline 对【已建立】的 WebSocket 不会立刻触发 `onclose` —— 页面会一直以为自己还在线，直到 40 秒后心跳判死。那测的就不是断线了。方式二适合测浏览器 `online` 事件驱动的立即重试。

---

## E2E-1 基础往返

> AC-1.3, AC-1.9, AC-4.1

1. 配对成功，进入主界面
2. Cookie 属性正确（`HttpOnly` / `SameSite=Strict`）
3. 自动创建（或手动创建）一个会话
4. 点终端，输入 `echo hello-webterm`，回车
5. 终端出现 `hello-webterm`
6. `stty size` 的输出与前端的 cols/rows 一致

---

## E2E-2 断线续传 ★ 核心

> AC-2.1, AC-2.2, AC-2.3, AC-2.5

### E2E-2a 基准 + 单次断开

1. 跑 `emit.sh 2000`，不断开 → `serialize()` → 基准
2. 新会话，再跑 `emit.sh 2000`，输出进行到约 50% 时切断 WS
3. 等 UI 显示"重连中"→"已恢复"
4. 等输出跑完
5. `serialize()` 与基准**逐字节相等**

### E2E-2b 断开 5 秒（缓冲不溢出）

同上，但断开后 `page.waitForTimeout(5000)` 再允许重连。断言字节一致。

### E2E-2c 断开期间输出超过 ring_bytes → 快照

> 用 `--ring-bytes 65536` 的实例。

1. 跑基准：`emit.sh 5000`，不断开 → 序列化**最后 2000 行 + 当前屏** → 基准
2. 新会话，断开，在断开期间让会话产出 > 64 KiB 输出（`emit.sh 5000`）
3. 重连
4. 断言：
   - `resumed[].status == "snapshot"`，随后收到 SNAPSHOT 帧
   - **没有**「历史输出已截断」之类的提示
   - 序列化的最后 2000 行 + 当前屏与基准**逐行一致**（屏幕级，AC-2.21）。比较前去掉行尾空白：快照把写出来的行尾空格记成空格子，`translateToString` 却会保留写出来的空格，Vitest 的逐格比较也是这样归一的
   - **重连后新产生的输出完全正确**（后续 `echo marker-xyz` 能正常显示）

### E2E-2d 连续快速断开

断开 10 次，每次间隔 300ms。最终字节一致（验证无累积错位）。

### E2E-2e 断点落在着色区间内

用 `emit.sh <行数> <延迟> mono` 输出一段跨越多帧的同色文本，**在这段中间**断开重连。断言：

- 走的是增量（`status == "ok"`），回放的字节与基准在同一位置逐字节相同 —— agent 不改写输出流（AC-2.5）
- 断点之后的文本颜色与基准一致

---

## E2E-3 断线期间的输入不丢

> AC-2.4

1. 建立会话，点终端
2. 切断 WS（不让它立即重连）
3. 在终端里敲三条命令：`echo A1`、`echo A2`、`echo A3`，各自回车
4. 输入没被静默吞掉：连接横幅显示「重连中」，且 `__webterm.inputStats().unackedBytes > 0`（这些字节在重发队列里）
5. 恢复连接
6. 终端依次出现 `A1`、`A2`、`A3`，**顺序正确、无重复、无丢失**。**按子串找，不按整行比**：三条命令在重连后一批到达，bash 跑第一条时内核会把后两条的预输入回显出来，readline 重画后输出行上可能留下回显的零头（实测 `A1p`、`inA1`、`A2r`，main 上 12 次 4 次）。所以输出标记要选命令回显里不会出现的串（命令写成 `printf "A%s-OK\n" 1`，输出 `A1-OK`，回显里只有 `A%s-OK`），在整段终端文本里数它出现几次、比位置
7. 断言重连过程中**没有出现 `input_gap`**：`welcome.resumed[].in_ack` 必须是断开前的累计值而不是 0（AC-2.12）

变体：断开期间提交超过 64 KiB 的输入 → UI 明确提示"离线输入已满"，不静默丢弃。

---

## E2E-4 快照路径的 UI 表现

> AC-2.6

见 E2E-2c。独立列出是因为它还要验证 UI 侧的表现：写快照之前清了屏（同一段内容只出现一份）、回看位置回到底部、不出现任何"截断"提示。

---

## E2E-5 连接状态指示

> AC-2.10

Pixel 5（`compact`）与 1440×900（`wide`）各跑一遍。

1. 在线：`compact` 上看不到横幅，`conn-text` 在 DOM 里、文本为「在线」、视觉隐藏；`wide` 上标签栏右侧 `conn-dot` 是在线色
2. 切断 → 横幅出现「重连中 · Ns 后重试」，倒计时递减；`wide` 上状态点变色
3. **横幅不改几何**：横幅出现前后 `.term` 的矩形逐字段相同，`__webterm.size()` 与 `__webterm.resizes()` 不变
4. 恢复 → 横幅消失，toast「已恢复 · 补齐 N KB」，3 秒后消失
5. 断言 toast 里的字节数与实际回放量一致（数量级即可）

---

## E2E-6 多会话与未读

> AC-2.11, AC-4.3

1. 创建会话 A、B
2. 在 A 里跑 `emit.sh 100 50`（持续输出）
3. 切到 B
4. A 出现未读标记（由 `session.updated{head_seq}` > 本地 `out_seq` 推导）：Pixel 5 上 `open-sessions` 带未读点（`data-unread=true`）、抽屉里 A 那行有未读点；1440×900 上 A 的标签有未读点
5. 在 B 里 `echo in-b`，正常工作
6. 切回 A：内容**完整**（切走期间的输出全在），未读标记清除
7. A 的滚动位置保持在切走前的位置（除非之前在底部，则跟到底部）

---

## E2E-7 中文 IME 输入

> AC-3.3, AC-3.14。文本输入页的组字见 E2E-40。

Playwright 可以派发 composition 事件。

### 终端直输

1. 点终端
2. 派发 `compositionstart` → `compositionupdate`（data: `ni`）→ `compositionupdate`（data: `你`）→ `compositionend`（data: `你好`）
3. 断言：`compositionend` 之前零 INPUT 帧；`compositionend` 时**一次**发出 `你好`
4. 组字期间光标位置有内联预览浮层

### 终端直输 · 切过会话之后（回归）

**每个会话有自己的 xterm 实例，也就有自己的 helper textarea**，而
`store.activate()` 会把上一个会话的 host 从 DOM 摘掉。所以切会话必须
重新挂 `RawIme`。

1. 建第二个会话并切过去
2. 点终端，派发 composition 事件
3. 断言：内联预览浮层可见 —— 没重新挂就不会出现。**这条是有效的回归点**
   （已用变异验证：还原成"只挂一次"后它失败）
4. 断言：`compositionend` 之前零 INPUT 帧 —— 留着防回归，但**它测不到本
   bug 的要害**：合成的 `CompositionEvent` 不会触发 xterm 的 `onData`，
   所以「`isComposing` 恒为 false → 组字字节直通 PTY，违反 AC-3.3」这个
   后果只有真输入法能演示（见 [自动化边界](../90-roadmap/milestones.md)）

### 终端直输 · 软键盘直接插入的标点（AC-3.14）

iPhone 中文键盘下「逗号打不进终端，句号可以」—— 同一个键盘上两个键报的 `keyCode` 不同，
xterm 一个接得住一个接不住（见 [input.md](../40-frontend/input.md#直接插入的文本ac-314)）。

终端直输时，对 helper textarea 按软键盘的样子派发 `keydown` → 插字符 → `input(insertText)` → `keyup`：

1. `keyCode: 0` 的「，」「！」→ **必须进终端**（修复前这里丢字，是本 bug 的要害）
2. `keyCode: 229` 的「。」→ 仍然进终端（xterm 的差量路，别被改坏）
3. `keyCode: 191` 的「？」→ 仍然进终端（xterm 的 keydown 路）
4. 组字提交「你好」紧跟一个 `keyCode: 0` 的「，」→ 两段都在，且**都只出现一次**（不重复发送）
5. 提交后终端输出里没有 `，，` / `你好你好` 这类重复
**另起一条用例**（不能并进上面那一串：上面第 5 步断言的是"终端里不该出现 `，，`"，而这一条要求的恰恰是出现 `，，`，两者只有在"这一串里没有连打"的前提下才不矛盾）：

6. **连打两下同一个 `keyCode: 0` 的「，」（两次派发在同一个 `evaluate` 里，间隔 < 120ms）→ 终端回显必须是两个「，」**。去重只该压住「另一条路已经送过」的那一次，不能把用户连打的第二下也吃掉 —— 那是静默丢弃（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)）。这条走的是**软键盘直接插入**那条路，第二下没有别的路会替它发，吃掉就是永久丢字

> 真机的事件序列没法在 headless 里完全复刻（`keyCode` 是 iOS 自己报的），
> 但「keydown 发生过 + insertText」这个组合就是要害，合成事件能精确覆盖它。

> 这个 bug 真的存在过（`attachIme` 里的 `if (ime) return` 让它只挂第一个会话），
> 而且只在 CI 上暴露 —— 原来的实现靠 `setInterval(attachIme, 300)` 轮询挂载，
> 本机跑得快正好赶上，CI 上就丢事件。轮询已换成在 `select()` 里确定性挂载。

---

## E2E-10 手机布局与附加键

> AC-3.18, AC-3.20

`web/e2e/mobile.spec.ts`，Pixel 5 设备描述（触屏）。hook `WebSocket.send` 记 INPUT 帧。

1. **结构**：`data-form=compact`；没有 `tabbar`；附加键区在终端下方、高 80px；左列是 `open-sessions` 与 `toggle-text`；键区 14 个键的 testid 依次为 `key-Escape key-Slash key-Minus key-Home key-ArrowUp key-End key-PageUp key-Tab key-Ctrl key-Alt key-ArrowLeft key-ArrowDown key-ArrowRight key-PageDown`
2. **全可见、不横滑**：键区 `scrollWidth ≤ clientWidth + 1`，14 个键的矩形都在视口内
3. **静态**：`sleep 30` 在跑、`less` 占屏、退出 `less` 之后，键区的 testid 序列都与第 1 步一致
4. **字节**：`key-Escape` → `1b`；`key-ArrowUp` → `1b5b41`；`printf '\033[?1h'` 打开 DECCKM 后 `key-ArrowUp` → `1b4f41`、`key-Home` → `1b4f48`；`printf '\033[?1l'` 后复原。每按一次，`inputStats().data.n` 都涨
5. **不抢焦点**：先点终端让它有焦点，按 `key-Tab` → `document.activeElement` 不变
6. **粘滞 CTRL**：点 `key-Ctrl` → `data-sticky=armed`；`keyboard.type('c')` → 发出 `03`，`data-sticky=off`；点 `key-Ctrl` 再点 `key-ArrowLeft` → 发出 `1b5b313b3544`（`ESC[1;5D`）
7. **锁定**：长按 `key-Ctrl`（> 500ms）→ `data-sticky=locked`；连续 `c` `u` → `03` `15`（不用 `d`：空提示符下的 `^D` 会让 bash 退出）；再点一下 → `off`
8. **点按终端**（AC-3.20）：点 `.term` 一下 → 焦点进 xterm 的 helper textarea；再点一下 → 焦点离开；纵向拖 30px 不改变焦点；**纵向拖动真的在滚**（有足够 scrollback 时连续拖 20 帧，`viewportY` 变化不止一行 —— 防 DOM 渲染器换掉行元素后 touchmove 落到脱离文档的节点上，只滚第一帧）；`printf '\033[?1000h'` 开鼠标跟踪后点一下 → 焦点不变、INPUT 帧里出现鼠标上报（`1b5b4d` 开头），`printf '\033[?1000l'` 复原
9. **安全区**：Chromium 里 `env(safe-area-inset-*)` 恒为 0，所以直接在 `.app` 上覆盖 `--sa-top: 47px`、`--sa-bottom: 34px` → 终端顶边落到 47px、附加键底边离 `.app` 底边 34px、`.app` 高度不变、终端正好矮 81px、页面不溢出；清掉 `--sa-bottom` → 复位
10. **横屏**：`viewport` 与 `screen` 都是 851×393 → 仍是 `compact`，附加键 80px、14 个键全可见

> **注**：Playwright 无法真正弹出软键盘。软键盘几何见 E2E-21（改容器高度、重放 `visualViewport` 事件来模拟），真机放在手工清单。

---

## E2E-11 会话生命周期

> AC-4.2, AC-4.5, US-7.3

1. 创建到上限（5 个，夹具里配的）→ `new-session` 禁用，并提示「会话数已达上限 5」
2. 在某会话里先 `printf 'LAST-%s\n' LINE`，再 `exit 1` → 终端末尾出现 `[进程已结束（退出码 1）· 按 Enter 关闭]`，它在 `LAST-LINE` **之后**；提示行是前端自己写的、不计入 seq：它出现之后 `__webterm.outSeq()` 不再变，且等于 agent 的 `head_seq`（刷新后用 `welcome.sessions[].head_seq` 核对）
3. 已退出会话的内容仍可滚动、可选择复制
4. 抽屉列表里显示 `exit 1`（警示色）；标签只变灰（`data-exited`），不显示退出码
5. **刷新页面** → 提示行在缓冲里**只出现一次**
6. 在该会话里按 `Enter` → 会话关闭（不需要确认），切到相邻会话
7. 关闭 `running` 会话（会话菜单 → 关闭）→ 弹 `close-confirm`（不是浏览器对话框：整个过程没有 `dialog` 事件），标题里有会话名，焦点在 `close-ok` 上；点 `close-cancel` → 浮层消失、会话还在；再关一次，按 `Esc` → 同样不关；再关一次，按 `Enter` → 会话关闭（ADR-0038）

---

## E2E-12 阅读输出

> AC-5.1, AC-5.3, AC-5.4

1. 跑 `emit.sh 3000` → 向上滚动能看到早期输出（无需进入任何模式）
2. **外观：默认跟随系统，设置里改主题与字号**（AC-5.3，[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)）：
   - 默认：`page.emulateMedia({ colorScheme: 'light' })` 下 `body` 与终端区（`.stage`）的背景是浅色（`--bg` / `--term-bg`），xterm 的主题背景（`.xterm-viewport` 的内联样式；CSS 把它的计算值压成透明）也是 `--term-bg`；切到 `dark`，**不刷新**，三者都换成深色；`<html>` 没有 `data-theme`；终端字号（`__webterm.fontSize()`）是 14；按 `Ctrl+Shift+,` 不出现任何浮层（`.drawer` 为 0 个）
   - 改主题：系统仍是 `dark`，点 `open-settings` → `settings` 出现，`theme-system` 是 `aria-checked="true"`；点 `theme-light` → **不刷新**，`<html data-theme="light">`，三处背景都是浅色；刷新 → 仍是浅色、配对过的页面一加载就是浅色；再打开设置点 `theme-system` → 回到深色、`data-theme` 被去掉
   - 改字号：记下 `__webterm.size()` 与 `resizes()`；点两次 `font-inc` → `font-size` 显示 16、`__webterm.fontSize()` 是 16、列数变少，且**发出了 `resize`**（`resizes()` 变大，最后一条 `resize` 的 `cols` 等于新列数）；刷新 → 仍是 16；连点 `font-dec` 到 10 → `font-dec` 变 `disabled`；`localStorage` 里只有 `webterm.fontSize`，没有按形态分的 key
3. 选中一段文本，此时有新输出到达 → **选区不被破坏**（选中的仍是原来那几行的内容）
4. 复制 → 剪贴板内容正确

---

## E2E-15 设备管理

> AC-1.3, AC-1.11

1. `GET /api/devices` 返回当前设备，`current: true`
2. 用第二个 browser context 完成第二次配对 → 两台设备
3. 从设备一吊销设备二 → **设备二的 WebSocket 在 5 秒内断开**，界面显示"此设备已被吊销"并跳到配对引导页
4. 一键吊销全部（`POST /api/devices/revoke-all`）→ 自己也退出，跳到配对引导页

> 前端没有设备管理界面（列表与吊销走 API 和 `webterm devices`），所以这里直接调 API。

---

## E2E-16 未认证访问

> AC-1.7, AC-1.8

1. 清除 Cookie 后访问 `/` → 静态页正常返回，前端显示"需要配对"引导
2. `GET /api/devices` → 401
3. **`GET /ws` 升级 → 401**（不能只测 REST）
4. 伪造 `Origin: https://evil.com` 的 WS 升级（带有效 Cookie）→ 403
5. 用错误的配对码 `POST /auth/pair`，按连续失败的退避间隔（1s、2s、4s、8s，见 [auth-pairing.md §限速](../60-security/auth-pairing.md#限速ac-16)）重试 → 前 5 次 401，第 6 次落在同一分钟里返回 429 + `Retry-After`；退避期内不等就重试也是 429

---

## E2E-27 手输数字配对码（ADR-0017）

> AC-1.15

`web/e2e/pairdigits.spec.ts`。夹具从 agent stdout 里抓 `dddd-dddd-dddd-dddd`。

1. 打开 `/pair`（没有 fragment）→ 出现数字输入框与「配对」按钮，按钮在不足 16 位时禁用
2. 把数字码**用空格分隔**粘进去 → 输入框显示成 `-` 分组的 16 位；点「配对」→ 跳到 `/`，`conn-text` 为「在线」
3. 同一次配对的 URL 码（二维码那把）此时已作废：另一个 context 打开配对链接 → 「配对码无效或已过期」
4. 输一个 16 位但错误的码 → 401 提示「配对码无效或已过期」，输入框仍在可重试

---

## E2E-17 PWA

> AC-1.14

1. `manifest.json` 可访问，字段完整
2. Service Worker 注册成功
3. 断网后刷新 → 显示"无法连接到 agent"的明确状态页（不是浏览器的默认错误页，也不假装能用）
4. 断言 Service Worker **没有缓存任何 `/api/*` 或 `/ws` 的响应**

---

## E2E-18 agent 重启后不张冠李戴

> AC-2.13

1. 开两个标签页，各自持有会话
2. 重启 agent 进程（会话全部消失，[ADR-0003](../20-architecture/adr/0003-no-tmux.md)）
3. 标签页 A 先重连并新建一个会话 → 它拿到 `sid = 1`
4. 标签页 B 随后重连，`hello` 里带着旧的 `instance_id` 与 `resume{sid:1, out_seq:很大}`
5. 断言：B 拿到的是 `status: "gone"`，UI 提示"会话已结束"，**屏幕上没有把 A 的新会话的输出接到 B 的旧内容后面**

---

## E2E-21 软键盘几何：键盘一弹附加键仍在可视区

> AC-3.8。`web/e2e/keyboard.spec.ts`，Pixel 5 视口。两种浏览器模型都覆盖（见 [`../40-frontend/layout.md`](../40-frontend/layout.md#高度计算ac-38)）：

1. **布局视口一起缩**（`resizes-content`）：点终端后把视口从 727 缩到 450 → `.app` 高 450、无 `translateY`、附加键完整落在 [0,450]、`data-form` 仍是 `compact`、`resize` 发出且 rows 变少
2. **只缩可视视口 + 上推**（iOS Safari / Chrome `resizes-visual`）：假 `visualViewport` 重放"可视 727→400、`offsetTop`→327"，分别在 **Safari 语义（`innerHeight` 跟着变 400）** 与 Chrome 语义（恒 727）下 → `.app` 必须 `translateY(327px)`、顶部 = 327、附加键在可视区 [327,727]；文本输入页聚焦时同样；键盘收起全部复位
3. **普通回弹不补偿**：`offsetTop` 变成 −40 / 60 而高度不变 → `.app` 无 `translateY`（守住拖动抖动的修复）

---

## E2E-26 热升级不丢会话（ADR-0016）

`web/e2e/reexec.spec.ts`。夹具给 agent 进程发 `SIGUSR2`（`Agent.reexec()`）——
真二进制原地 exec 同一个文件，PID 不变，stdout 管道照旧。

1. 起一条持续输出的命令（300 行、每行间隔 20ms、最后打 `REEXEC-DONE`），输出中途发 `SIGUSR2`
2. 浏览器只看到一次重连：`conn-text` 短暂离开「在线」后回到「在线」；重连后的 `welcome.resumed[0].status == "ok"`（`instance_id` 没变）
3. 命令跑完后终端里 300 行**每行恰好一次、顺序正确**（不丢不重），`REEXEC-DONE` 在
4. shell 仍活着：再提交一条命令有输出；`webterm reload --probe` 对新进程返回 0，`status` 里的 `generation` 为 1
5. **模拟器状态交接了**：等输出跑完、会话静止，再热升级一次；这次升级前后各开一个新标签页（`out_seq == 0`，走快照）序列化终端，两份逐行一致
6. 预检失败路径：把 `--handoff-check-fail` 之类的注入留给 Go 集成测试（IT-handoff-1），E2E 不模拟

---

## E2E-28 浮层与手机会话抽屉

> AC-4.10, AC-5.11, AC-4.8。`web/e2e/drawer.spec.ts`，Pixel 5。触屏抽屉有约 170ms 的 `sheet-up` 进场动画：量「贴底」或长按抽屉里的行之前先等动画结束（`animationend`，或等矩形两次读数相同），否则拿到的是半路的位置。

1. **形态**：会话按钮 `open-sessions` 里的数字等于会话数（`1`）；点它 → `session-drawer` 贴底（底缘与可视区底部差 ≤ 1px）、整宽、有抓手 `.drawer-grab`、标题栏有 ✕；底部固定一行是 `new-session` 与 `open-settings`，各有一个 SVG 图标；从抽屉新建一个会话后按钮里是 `2`；在抽屉里左滑它 → `row-close` → `close-confirm` 是贴底 sheet、**叠在抽屉上**（两个 `.drawer`），按 `Esc` 只关掉确认、抽屉仍在；再关一次点 `close-ok` → 行消失、抽屉仍开着，按钮里变回 `1`（AC-4.11）
2. **焦点进浮层**：每次打开，`document.activeElement.closest('.drawer')` 非空
3. **关闭方式**（会话抽屉）：点遮罩、`Esc`、✕、选中一个会话、`page.goBack()`（系统返回键）各关一次；`goBack` 之后页面仍在 `/`；五次开关之后 `history.length` 至多比开始时多 1
4. **不挤终端**：开关抽屉前后 `.term` 的矩形逐字段相同，`__webterm.size()` 与 `resizes()` 不变
5. **焦点恢复**（AC-4.8）：先点终端让它有焦点 → 开抽屉 → 选另一个会话 → 焦点在新会话的 helper textarea 上；先让终端失焦 → 开抽屉 → 选会话 → 焦点**不**在终端
6. **行操作**（AC-4.12，ADR-0039）：两个会话。触摸左滑第二行 120px → 松手后它停在打开（行内容左移 216px），`row-pin` `row-rename` `row-close` 可见；只左滑 60px → 弹回；打开后右滑 → 关上；纵向拖列表不打开任何一行。长按一行 → 同样打开、**不出现** `session-menu`；再左滑另一行 → 前一行关上；点开着那行的正文 → 关上、当前会话不变。`row-pin` → 名字前出现图钉（`.pin-mark` 里是 SVG）、行关上。`row-rename` → `rename-sheet` 叠在抽屉上（两个 `.drawer`），`rename-input` 有焦点、内容全选、字号 16px；输入 `RENAMED` 按 `Enter` → sheet 消失、抽屉仍在，那一行显示 `RENAMED`；再打开改名清空按「保存」→ 恢复自动命名；再打开改名按 `Esc` → 只关改名
9. **浮层跟着可视区**（ADR-0039 §3）：打开改名 sheet 后把视口高度减 300px（模拟可视视口被键盘压缩：`.app` 的高度跟着变）→ `rename-sheet` 的底边与 `.app` 的底边差 ≤ 1px，`rename-input` 整个在 `.app` 的矩形里；`session-drawer` 的高度 ≤ `.app` 高度的 80%
7. **高度与留白**（AC-5.11，ADR-0037 §5）：只有 1 个会话时打开抽屉 → `session-drawer` 的高度 ≥ 可视区高度的 50%（差 ≤ 1px）；底部一行贴着 sheet 底部；`new-session` 的底边与 sheet 底边之间 ≥ 16px、左边与 sheet 左边之间 16px，`open-settings` 的右边与 sheet 右边之间 16px，两个按钮之间 12px，两个按钮一样高（48px）
10. **路径与名字**（ADR-0042 §3）：三个会话，分别 `cd` 到 `/usr/local/share`、`e2e/fixtures`（绝对路径，通常在家目录下，显示成 `~/…`）、`/`；打开抽屉 → 每一行路径文本节点的**第一个字符显示在最后一个字符左边**（用 `Range` 量字符的实际矩形；只比 `textContent` 测不出颠倒），最后一个字符整个落在 `.sl-meta` 的矩形里；`fixtures` 那一行的名字整个可见（`.sl-text` 的 `scrollWidth ≤ clientWidth`）
8. **从抽屉进设置**：点 `open-settings` → `session-drawer` 消失，`settings` 出现，贴底整宽、有抓手；它的高度小于可视区的 50%（不套会话抽屉的最小高度）；`font-inc` 的底边与 sheet 底边之间 ≥ 16px；点遮罩关闭

---

## E2E-30 切走 → 积压超过 ring_bytes → 切回（AC-2.6 / AC-2.15）

> 用 `--ring-bytes 65536` 的实例。`web/e2e/subscribe-reset.spec.ts`。
>
> E2E-2c / E2E-4 走的是重连（`welcome.resumed[].status`），这条走切回（`subscribe`），是另一条代码路径。

**后台产出必须先 `sleep` 几秒再开始**（`(sleep 3; for …; done; printf '\033[6n'; touch <done>) &`）：那几秒用来切到别的会话，保证整段输出都落在「未订阅」期间。完成信号走**文件**（测试进程直接 `existsSync`）—— 会话已经切走，屏幕上看不到它跑完没有。

### ① 积压超过 ring_bytes → 快照

1. 建会话 A。A 里 `printf 'MARK-%s\n' ONE`，等它显示
2. A 里起后台输出：2500 行 × 70 B ≈ 175 KiB，末尾一个 CPR 查询（`\033[6n`）
3. 新建 B 切过去，等完成文件出现
4. 切回 A，断言：
   - 客户端发出的 `subscribe` **自带 `cols`/`rows`**，并且**没有任何 `resize` 排在它前面**（hook `WebSocket.send`）
   - 收到的是 SNAPSHOT 帧，不是从旧位置接着的 OUTPUT
   - **`MARK-ONE` 在终端里出现 0 次** —— 快照只带最后 2000 行，它早已超出。还在就说明没清屏，快照被接在了旧屏幕后面
   - 客户端**没有**把 CPR 应答（`ESC[<行>;<列>R`）作为 INPUT 发出去
5. 再来一轮（切走、再产出一轮、切回），断言**缓冲区行数与上一轮相差不到一屏**：每轮都是重建，不是往后追加

### ② 积压没超过 ring_bytes → 增量补齐

同样的流程，但只产 200 行（≈ 14 KiB，远小于 64 KiB），末尾同样带一个 CPR。切回后断言：

- 收到的是 OUTPUT 帧（增量），没有 SNAPSHOT；`MARK-ONE` 还在 —— 增量补齐不该清屏
- 切走期间的输出补齐了（`few 0200` 可见）
- 客户端**没有**发出 CPR 应答

### ③ 重连补课同样不应答（对照）

`web/e2e/replay-echo.spec.ts`。② 测的是切回（`subscribe`）路径的增量补课，这条是同一规则在**重连**（`welcome.resumed[].status == "ok"`）路径上的对照：

1. 提交 `sleep 2; printf '\033[6n'; sleep 30`，立刻断开，让这个 DSR 查询落在离线窗口里
2. 3 秒后恢复，断言走的是增量（`status == "ok"`）
3. 等补课写进 xterm，断言客户端**没有**把 CPR 应答作为 INPUT 发出去

> ② 是 AC-2.15 真正的看门人：增量路径上**没有任何线上信号说"这段是历史"**，全靠客户端自己记 `catchup_to`。漏了它，每切回一次会话，前台程序就收到一串乱码按键。

---

## E2E-31 备用屏会话切回 = 当前屏（AC-2.6 / AC-2.21）

> 用 `--ring-bytes 65536` 的实例。`web/e2e/redraw.spec.ts`。
>
> 字节窗口拼不出备用屏程序的当前屏（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §背景），快照可以：模拟器手里就是那一屏。

夹具 `e2e/fixtures/altscreen.sh <快跑秒数> <完成标记文件>` —— 一个假的全屏 TUI，行为对齐实测到的 claude：

- 启动就 `ESC[?1049h` 进备用屏，**整个生命周期只发这一次**
- 画一屏（含一行 `FRAME <n>` 标记），之后只重画内容行（差分、绝对定位、**不清屏**），约 30 KB/s
- 快跑到点之后 `touch` 标记文件并**转入空闲，一个字节都不产**
- 收到 `SIGWINCH` 整屏重画，`FRAME` 计数加一；收到 `SIGINT` / `SIGTERM` 时 `ESC[?1049l` 退回主屏

1. 建会话 A，跑 `altscreen.sh`，等屏幕出现 `FRAME`
2. 新建 B 切过去；等标记文件出现（= A 的积压已经顶过 64 KiB 且已转入空闲）
3. 切回 A，断言：
   - 收到 SNAPSHOT 帧，且 **SNAPSHOT 的字节数 < 8 KiB**（当前屏是 KB 量级，不是整个 `ring_bytes`）
   - `__webterm.altScreen()` 为 `true`：快照把客户端带回了备用屏
   - 屏幕上 `FRAME` 只出现 **1 次**，scrollback 里没有这个程序界面的任何副本
   - 切回时 agent **没有**改窗口尺寸（`altscreen.sh` 的 `FRAME` 计数没有因为 SIGWINCH 增加）
4. 让 `altscreen.sh` 退出（回到主屏），再在 A 里积压一轮超过 `ring_bytes` 的输出，切走 / 切回一次：仍走快照，主屏是 shell 的内容，没有残影。不积压的话退出后会话空闲，切回走的是增量，测不到快照

---

## E2E-33 僵尸连接：回到前台立刻戳穿（AC-2.20，ADR-0020）

> `web/e2e/zombie.spec.ts`。

**僵尸连接 = 线路断了但没有 `onclose`。** 手机息屏、切 App、Wi-Fi 切蜂窝、NAT / 反向代理静默回收，TCP 上都没有 FIN，浏览器那边 `readyState` 一直是 OPEN。页面自认在线，打字全写进一条死 socket，屏幕上什么都不变。

夹具：`installWSControl` 的第三种状态 `goZombie()` —— **已建立的那条连接两个方向都不再转发，但不关闭**；新连接像线路断了一样直接 `close(1006)`。这比 CDP 的 offline 精确：CDP 那条路对 `routeWebSocket` 代理过的连接不成立，而"不关闭"正是要测的要害。

1. 配对、打开、等「在线」
2. `net.goZombie()`。断言状态条**还是**「在线」—— 这就是问题的样子，页面根本不知道线断了
3. 派发一次 `visibilitychange`（页面回到前台）
4. 断言 **5 秒内**状态条离开「在线」（变成「重连中」/「连接中」）。改之前这里要等 40 秒（30s 心跳 + 10s pong 超时）
5. `net.goOnline()`，断言回到「在线」
6. 断言僵尸期间敲进去的那行命令**最终执行了**（按 `in_ack` 重发，AC-2.4）—— 探活不能把输入弄丢

---

## E2E-34 打字不该消失（AC-4.8 / AC-2.15 / AC-3.3，ADR-0020）

> `web/e2e/inputalive.spec.ts`。三个用例，三条互相独立、症状完全相同的路：敲下去没反应。

### ① 切会话之后直接打字（AC-4.8）

1. 建会话 A，点一下终端，打一行 `echo ONE`，确认回显
2. `Ctrl+Shift+Enter` 新建会话 B（焦点在终端上）
3. **不点终端**，直接 `keyboard.type('echo TWO')` + 回车 → `TWO` 必须出现
4. `Ctrl+Shift+↑` 切回 A，同样不点终端，打 `echo THREE` → 必须出现

> `activate()` 的 `prev.host.remove()` 把焦点丢回 `body`，改之前第 3 步起键全落在 `body` 上。

### ② 回放期间打字（AC-2.15）

1. 会话 A 里起后台输出，产 **1 MiB**（默认 ring 256 KiB，保证切回时走快照）
2. 切到 B，等完成文件出现
3. 切回 A，**不等任何东西**，立刻 `keyboard.type('echo REPLAYKEY')` + 回车
4. 断言 `REPLAYKEY` 的回显出现

> 回放门要按来源区分，不能按"此刻是否在回放"一刀切。这一步和 E2E-30 ② 是一对：那条断言自动应答**不**进 PTY，这条断言用户按键**要**进 PTY。

### ③ `compositionend` 没来（AC-3.3）

1. 在终端的隐藏 `textarea` 上派发 `compositionstart` + `compositionupdate`，**不派发 `compositionend`**
2. 断言此时打字确实不进 PTY（组字期间一个字节都不发，AC-3.3 的原有语义不能破）
3. 派发 `blur` → 再打字 → 必须进得去
4. 再来一轮，这次用一个 `isComposing === false` 的普通 `keydown` 兜底 → 必须进得去

> 改之前 `composing` 只有 `compositionend` 一个出口，它不来就永久卡住，该会话的终端输入到刷新为止都是死的。

### ④ 输入路径可观测（AC-3.17）

1. 点终端打一个字符并确认回显 → `__webterm.inputStats()` 的 `keydown` / `toTerm` / `data` / `sent` **四段都涨**，`gated` 为 0，`verdict` 说四段都通
2. **焦点丢掉的指纹**：`activeElement.blur()` 之后再敲一个键 → `keydown` **涨**，`toTerm` **不涨**，`focus` 字段写着焦点已经不在终端，`verdict` 指向"焦点不在终端"
3. 上一步同时证明了**计数按最近一次发生判、不按总量判**：第 1 步已经让四段的总量都大于 0，拿总量做断言的话这条场景恒绿

> 不测"组字卡住"的指纹：真实事件下它复现不了 —— 一个 `isComposing === false` 的 `keydown` 就会触发兜底复位（③ 的修复），组字状态立刻解开。那一段的判定逻辑由 UT-inputstats-1 覆盖。

> 这条不测"输入能不能进去"（那是 ①②③ 的事），测的是**卡住时能不能一眼看出断在哪一段**。ADR-0020 的原则本身需要可观测性，否则下次还是从猜开始。

---

---

## E2E-35 当前会话一眼可辨（AC-4.9）

> `web/e2e/sessionactive.spec.ts`，1440×900（标签栏）与 Pixel 5（抽屉）。**断言的是"看得出来"，所以量计算样式，不量 class 名。**

1. 建三个会话
2. **只有一个当前**：`tabbar` 里 `[aria-current="true"]` 恰好一个，且 `data-sid` = `__webterm.sid()`
3. **当前 ≠ hover ≠ 普通**：鼠标悬到某个非当前标签上，取三处 `backgroundColor` —— 当前、hover、两者都不是的标签，**两两不相等**；当前标签有强调色下划线
4. **跟着切换搬家**：`Ctrl+Shift+↓` → `aria-current` 落到相邻标签，原来那个不再有
5. **已经可见时不滚**：标签都看得见时来回切两次，`tabbar` 的 `scrollLeft` 始终是 0
6. **滚进可视区**：`screen` 1440×900、`viewport` 600×900，建到 5 个会话（标签最窄 120px，5 个放不下），`Ctrl+Shift+↓` 切到最后一个 → 该标签的矩形**完全落在** `tabbar` 的矩形内且 `scrollLeft > 0`；再切回第一个 → 同样完全可见
7. **抽屉里同一套**（Pixel 5）：打开抽屉，当前行 `aria-current="true"` 恰好一条，且有强调色左条（`box-shadow` 含 inset）

---

## E2E-36 刷新之后仍能往回拖（AC-5.14）

> `web/e2e/refresh-scrollback.spec.ts`。默认 `--ring-bytes`。

1. 起会话，`emit.sh 3000 0`，等 `EMIT-DONE`
2. `page.reload()`，等重新连上：订阅走快照（`out_seq == 0`）
3. **能滚回去**：序列化结果里 `line 01500` 仍在（最后 2000 行之内），`line 00100` 不在（超出 2000 行）。视口要够宽（1440×900，≥ 147 列）：一行折成两行的话，2000 行只装得下约 1000 条，`line 01500` 会掉出去
4. **只有一份**：`line 01500` 在整个缓冲里出现次数 **== 1**
5. **接得上**：刷新后再跑一次 `printf 'AFTER-%s\n' RELOAD`，它出现且前面的内容不重排
6. **agent 重启则没有旧会话**：杀掉 agent 重新起（`instance_id` 变，会话全部销毁 —— [ADR-0003](../20-architecture/adr/0003-no-tmux.md)），刷新后新建会话 → 终端里**不出现任何 `line 0…`**
7. **备用屏会话刷新后是当前屏**：`fixtures/altscreen.sh` 的会话刷新后，`FRAME` 只出现一次，scrollback 里没有它界面的副本

---

## E2E-37 滚动与写入的基线测量（只记录，不断言）

> `web/e2e/scrollperf.spec.ts`，phone 视口。[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7：输出链路先用原生，这条场景量出原生的表现，作为将来"要不要加优化"的依据。**这台机器没 GPU，只看主线程毫秒数。**

记录并打印（写进测试报告，不做断言）：

1. `emit.sh 4000 0` 期间，主线程 `duration > 50` 的长任务个数与最长一次
2. 输出跑完后，合成 20 帧的单指纵向拖（每帧 12px），拖动期间的长任务个数
3. 切回一个积压 1 MiB 的会话（走快照）时，从按下切换键到快照写完的耗时与长任务个数

要加回任何一项优化（按帧合并、回看暂停、写入预算、WebGL、自写滚动），先拿这几个数对比，带着数据写 ADR。

---

## E2E-39 形态（AC-5.18）

> `web/e2e/form.spec.ts`。形态按屏幕短边判，所以 context 要同时给 `viewport` 与 `screen`。

1. Pixel 5（`screen` 393×851）→ `data-form=compact`：有 `open-sessions`，没有 `tabbar`
2. `viewport` 与 `screen` 都是 851×393（手机横屏）→ 仍是 `compact`
3. iPad Mini 设备描述（`screen` 768×1024，触屏）→ `wide`：有 `tabbar`（高 40px），没有 `open-sessions`；附加键在，左列只有 `toggle-text`
4. 1440×900 鼠标 → `wide`：`tabbar` 高 36px，没有附加键
5. **键盘弹出不改形态**：在 3 的 context 里把视口高度缩到 344（模拟平板横屏弹键盘）→ `data-form` 仍是 `wide`、`tabbar` 仍在
6. **旋转不改形态**：3 的 context 把视口换成横屏 → 仍是 `wide`

---

## E2E-40 文本输入页（AC-3.19, AC-3.10, AC-3.22）

> `web/e2e/textinput.spec.ts`，Pixel 5。hook `WebSocket.send` 记 INPUT 帧，断言时把这一步的帧拼起来比（粘贴与回车是两次 `onData`，分不分帧不重要）。E2E 的 bash 开了括号粘贴。

1. **切换不动几何**：点 `toggle-text` → `textinput` 可见且有焦点；前后 `__webterm.size()` 与 `resizes()` 不变；**文本框四边的 `border-*-width` 都 ≥ 1px，整个框（含边框）落在 `extrakeys` 的矩形内、四边都留出空隙**；再点 `toggle-text` → 回键位页
2. **滑动也能切**：在键区上横向拖 80px → 文本页；反向拖回 → 键位页
3. **attribute**：`textinput` 的 `autocorrect` / `autocapitalize` / `spellcheck` 的 attribute 实际值分别是 `off` / `off` / `false`，`enterkeyhint` 是 `send`
4. **有内容回车 = 发送并回车**：填 `echo TEXT-ONE` 回车 → 这一步的 INPUT 帧拼起来是 `ESC[200~echo TEXT-ONEESC[201~` + `0d`；命令执行、输出里出现 `TEXT-ONE` 一行；文本框已清空、焦点仍在文本框；`inputStats().data.n` 与 `sent.n` 都涨
5. **空回车**：再回车 → INPUT 帧是 `0d`
6. **组字**：派发 `compositionstart` → `compositionupdate`（`ni`）→ 按 `Enter`（`isComposing: true`）→ **没有 INPUT 帧**；`compositionend`（`你好`）后回车 → INPUT 帧拼起来是括号包好的 `你好` + `0d`
7. **多行内容整块粘贴再回车**：往文本框粘贴 `echo L1⏎echo L2` 后回车 → INPUT 帧拼起来以 `1b5b3230307e` 开头、以 `1b5b3230317e0d` 结尾，中间的换行已转成 `0d`；两行都执行，输出里出现 `L1` 与 `L2`
8. **回车不插换行**：以上每一步之后，`textinput.value` 里都没有 `\n`
9. **跟着会话走**（AC-3.22 / AC-4.8，[ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)）：会话 A 在文本页，框里填 `echo DRAFT-A`（不回车）；从会话抽屉新建会话 B → B 是键位页（`extrakeys[data-page=keys]`、`textinput` 不可见），焦点在 B 的终端里。B 里点 `toggle-text`，填 `echo DRAFT-B`。从抽屉切回 A → 文本页，`textinput.value` 是 `echo DRAFT-A`，焦点在文本框；回车 → 只有 A 的输出里出现 `DRAFT-A`。从抽屉切到 B → 文本页，值是 `echo DRAFT-B`；点 `toggle-text` 回键位页，切到 A → A 仍是文本页、框是空的（刚才发掉了）；再切回 B → 键位页，焦点在终端；整个过程没有任何一次把 `DRAFT-B` 发出去

---

## E2E-41 宽屏标签栏（AC-4.10）

> `web/e2e/tabs.spec.ts`，1440×900 鼠标；第 7 步用 iPad Mini 设备描述，第 8 步中途把窗口改窄。`open-settings` 与设置浮层见 [ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)。`+` 的位置见 [ADR-0035](../20-architecture/adr/0035-tabbar-new-button-pinned.md)。

1. **结构**：顶栏在终端上方；`tabbar`（标签条）里只有一个标签，`new-session` 在顶栏里、**不在** `tabbar` 里，位于标签条右边、左边缘距标签条右边缘 12px（ADR-0035）；右侧钉住 `conn-dot` 与 `open-settings`，`open-settings` 在最右、`conn-dot` 紧挨在它左边；`new-session` 里的 SVG、`open-settings` 里的 SVG 与 `conn-dot` 三者的垂直中心两两相差 ≤ 0.5px，两个 SVG 一样大；没有 `open-sessions`，没有附加键
2. **新建与切换**：点 `new-session` → 多一个标签且它是当前；点第一个标签 → `__webterm.sid()` 切回去；整个过程 `.term` 的矩形与 `__webterm.size()` 不变
3. **关闭**：悬停非当前标签出现 ✕，点它 → 会话在跑时先弹 `close-confirm`（居中浮窗，不是浏览器对话框），点 `close-ok` 后标签消失；中键点标签同样先确认；焦点在终端里时按 `Ctrl+Shift+W` → 确认浮层，按 `Enter` → 关闭，焦点回到新的当前会话的终端（AC-4.11）
4. **改名**：标签有 `tab-<sid>-idx`，内容是 `[n]`（它在顺序里的位置）；双击标签 → `rename-input` 出现，输入 `RENAMED` 回车 → 标签文字是 `RENAMED`，`tab-<sid>-idx` 仍是 `[n]`（改过名的也带编号，ADR-0041）；再双击、清空、回车 → 恢复自动命名（CWD 的 basename）
5. **会话菜单**：右键标签 → `session-menu` 有 `session-rename` `session-pin` `session-close`；点 `session-pin` → 标签名前出现图钉（`.pin-mark` 里是 SVG）；切走后仍持续收到该会话的 OUTPUT 帧、`seq` 在涨，它也不出未读点（`__webterm.outSeq()` 只报当前会话，所以看帧）
6. **未读**：A 跑持续输出，切到 B → A 的标签出现未读点，颜色是强调色（与当前标签的文字同色，不是 `--err`，ADR-0042）；切回 A → 消失
7. **触屏**（iPad Mini）：✕ 只在当前标签上；长按标签后原地松手 → `session-menu`；附加键在，左列只有 `toggle-text`；`new-session` 与 `tabbar` 右边缘相距 16px
8. **等宽与滚动**（ADR-0031 / ADR-0035）：建到 3 个会话 → 三个标签等宽（差 ≤ 1px）、都是 240px，`tabbar` 正好是三个标签的宽度、不横向滚动（`scrollWidth` = `clientWidth`），`new-session` 的左边缘 = 最后一个标签的右边缘 + 12px；把窗口改成 600×900（`screen` 不变，仍是 `wide`）、建到 5 个 → 每个标签 120px（差 ≤ 1px），`tabbar` 放不下（`scrollWidth > clientWidth`），当前（最后建的）整个可见；**`new-session` 整个落在顶栏里、可点（`elementFromPoint` 命中它），左边缘 = `tabbar` 右边缘 + 12px**；把 `tabbar` 滚到最左（`scrollLeft = 0`）→ `new-session` 的位置不变；（此时 `scrollLeft` 为 0）鼠标悬在标签条上纵向滚轮向下再向上 → `scrollLeft` 先变大后变小；窗口改回 1440 → 5 个都是 240px，不再横向滚动
9. **间隔不可点**（ADR-0035 §2）：两个会话，焦点在终端里；在最后一个标签右边缘与 `new-session` 左边缘之间那 12px 的正中点击 → 会话数不变、当前会话不变、焦点仍在终端里
10. **设置是居中浮窗**（AC-5.11，ADR-0037 §4）：焦点在终端里，点 `open-settings` → `settings` 水平、垂直都居中（中心与可视区中心差 ≤ 1px），宽 420px，没有抓手；`.term` 的矩形与 `__webterm.size()` 不变；按 `Esc` → 浮层消失，焦点回到终端的 helper textarea（打字有回显）
11. **终端标题作名字**（AC-4.4，ADR-0043）：harness 的 shell 读用户的 `.bashrc`，提示符可能设 `user@host: dir` 标题 —— 等两秒，标签名仍是 `~`（shell 设的不用）；跑 `bash -c 'printf "\033]0;E2E TITLE\007"; sleep 3'` → 标签名变成 `E2E TITLE`、编号仍在；它退出回到提示符 → 标签名回到 `~`

---

## E2E-42 列数变了重发快照（AC-2.22）

> `web/e2e/resync.spec.ts`。hook `WebSocket` 的 message 与 send。

1. 起会话，`emit.sh 300 0`，等完成
2. 把窗口从 1280 宽改到 1000 宽（列数变少）→ 客户端发出 `resize`，随后收到一份 SNAPSHOT
3. 断言：快照之后终端的列数等于新的 `cols`；`line 00300` 仍在且只出现一次
4. 只改高度（`page.setViewportSize` 只改 height，模拟软键盘）→ 发出 `resize`，**不**收到 SNAPSHOT
5. **列数稳定**（AC-3.11，[ADR-0033](../20-architecture/adr/0033-own-fit.md)）：窗口宽度从 860 到 940 每次加 4px；每个宽度上等行列落定，再只把高度减 200 → 每一次 `__webterm.size().cols` 都和改高度之前相同（FitAddon 时代在 900px 上会 104 → 103）

## E2E-43 切开的 UTF-8 不丢字（AC-2.23）

> `web/e2e/utf8split.spec.ts`。

1. 在终端里跑 `printf '\xe3\x80'; sleep 0.3; printf '\x82\xe2\x80'; sleep 0.3; printf '\xa6\xe2\x80'; sleep 0.3; printf '\x94END\n'` —— `。`、`…`、`—` 各被切在第 2 字节之后，分别落在不同的 OUTPUT 帧里
2. 断言终端那一行是 `。…—END`
3. 刷新页面（走快照）后同一行仍是 `。…—END`

## E2E-44 触屏纵向拖转滚轮（AC-3.21）

> `web/e2e/touchwheel.spec.ts`，Pixel 5，CDP 发真实触摸（每步隔 30ms，像人手）。hook `WebSocket.send` 记 INPUT 帧。夹具 `e2e/fixtures/scroller.py N`：备用屏 + 鼠标跟踪（SGR），显示 `L001`…`L300` 里的一屏，每收到一次滚轮按 N 行滚动。

1. 跑 `scroller.py 5`（tmux copy-mode 的步长），等底部出现 `L300`
2. **一行高一次**：手指向下拖 10 行高 → 发出 10 ± 1 个滚轮，屏幕顶行的编号减少约 50（10 × 5，±5）；发出的都是 SGR 滚轮向上（`ESC[<64;列;行M`），行号在 1…`rows` 之内；焦点不变（不是点）
3. 手指向上拖 6 行高 → 发出 6 ± 1 个滚轮，都是滚轮向下（`ESC[<65;…M`），顶行编号增加约 30（±5）
4. 退出，换 `scroller.py 1` 再向下拖 10 行高 → 顶行编号减少 10 ± 2（步长 1 时逐行跟着手指）
5. **横向拖 120px** → 没有 INPUT 帧
6. 退出，跑 `printf '\033[?1049h\033[?1000h\033[?1006h'; sleep 60` 再 `Ctrl+C`、`printf '\033[?1000l'` 关掉鼠标跟踪（仍在备用屏）→ 向下拖 → 没有 INPUT 帧（不发方向键，ADR-0024 §4）

## 不在 E2E 覆盖范围（放手工清单）

- 真机中文输入法的实际候选框行为
- 真实软键盘的弹出动画与布局
- 真实网络切换（Wi-Fi ↔ 4G ↔ 隧道）
- 真实 Let's Encrypt 签发
- PWA 真机安装
- Android 系统返回键（E2E 用 `page.goBack()` 模拟）
- 触觉反馈

## E2E-45 拖动排序（AC-4.13）

> `web/e2e/order.spec.ts`。[ADR-0040](../20-architecture/adr/0040-session-order-drag.md)。

1. **wide 鼠标**（1440×900）：建到 3 个会话 A B C → 鼠标按住 C 的标签往左拖过 A 的中线松手 → 标签顺序是 C A B，编号（`tab-<sid>-idx`）依次是 `[1] [2] [3]`，当前会话不变（拖完不切换）；发出一条 `session.move{sid: C, before: A}`，随后收到 `session.order{sids: [C, A, B]}`；按住 B 横移 3px 松手 → 只是点击（切到 B），不发 `session.move`
2. **拖到一半按 Esc**：按住 A 往右拖过 B，不松手按 `Esc` → 回到原位，松手后不发 `session.move`
3. **顺序在 agent 上**：刷新页面 → 仍是 C A B；再开第二个 browser context（第二台设备）→ 它的标签顺序也是 C A B；在第一个里再拖一次（A 拖到最后）→ 第二个不刷新就变成 C B A
4. **compact 拖动柄**（Pixel 5）：同一个 agent 上，打开抽屉 → 每行右端有 `session-<sid>-grip`；触摸按住最后一行的柄往上拖到第一行上方松手 → 它成为第一行、编号 `[1]`；按住一行的正文纵向拖 → 是滚动列表，顺序不变
5. **触屏 Pad**（iPad Mini）：长按一个标签 500ms 后不松手横移过相邻标签再松手 → 顺序变了、不出现 `session-menu`；长按后原地松手 → 出现 `session-menu`
6. **键盘切换按新顺序**：顺序是 C B A、当前是 C → `Ctrl+Shift+↓` 到 B
