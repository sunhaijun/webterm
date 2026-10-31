# ADR-0023 终端字体：只列本机装了的等宽字体

状态：已接受（2026-09-13）

## 背景

字号可调（AC-5.3），字体不可调 —— xterm 拿到的是一串写死的 fallback：

```
ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas,
"Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace
```

在 MacBook 上这串的第一名 `ui-monospace` 就命中 SF Mono，用户装了 JetBrains Mono
也轮不到它；在只装了 DejaVu 的 Linux 上则谁都没得选。终端是盯一整天的界面，
字体的可选性和字号是同一个量级的基本设置，不该由一串 fallback 替用户决定。

## 决策

**给一份硬编码的等宽优选清单，打开设置时探测本机装了哪些，只列探测到的。**

清单见 [`../../40-frontend/layout.md`](../../40-frontend/layout.md)，
实现是 `web/src/ui/fonts.ts`。三条附带的规矩：

1. **每一项都是一整段 stack，尾巴恒为 CJK 等宽 + `monospace`**：
   `"JetBrains Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace`。
   编程字体几乎都不带汉字，少了这条尾巴，汉字会掉进比例字体，中英混排的列宽当场歪掉。
2. **只存一份，不按断点分。** 字号按断点分是因为它跟"这块屏幕多大"有关；字体跟的是
   "这台设备装了什么"，同一台机器改个窗口宽度不会换字体。键是 `webterm.font.family`，
   **存 id 不存 stack** —— 将来清单里的 stack 改了，老配置仍然认得出。
3. **改字体 = 改 cell 尺寸 → 必须 `fit()` 再补一条 `resize`。** 容器一个像素都没变，
   `ResizeObserver` 不会响；只 fit 不发的话客户端和 PTY 的 cols/rows 就分了家，
   全屏程序的绝对定位会整屏错位。**改字号原来就漏了这一条**，一并补上。

## 探测：canvas `measureText` 比三条基线

```ts
const BASES = ['monospace', 'serif', 'sans-serif']
const w = (family: string) => ctx.measureText(PROBE).width   // ctx.font = `72px ${family}`
const installed = (name: string) => BASES.some((b) => w(`"${name}", ${b}`) !== w(b))
```

- 没装的字体名会被整段忽略，`"X", serif` 量出来就是 serif 的宽度 —— 三条基线全都一样宽，
  即"本机没有"。
- **只比 `monospace` 一条不够**：清单里的 Menlo / Consolas 很可能**就是**浏览器的默认等宽
  字体，宽度一样，会被误判成没装。三条里只要有一条不一样就算装了。
- **不用 `document.fonts.check()`**：Chrome 对没装的字体名同样返回 `true`（它回答的是
  "这个 font list 里的 webfont 都加载完了吗"，不是"本机有没有这个字体"），拿它当探测器
  等于把清单整个列出来。
- **不用 `queryLocalFonts()`**：要弹权限提示，且只有 Chromium 系有。为一个字体选择器不值当。
- 探测结果**在页面存活期内缓存一次**。它不会中途变，而设置面板可能被开关很多次。
- 拿不到 canvas 2d 上下文时探测返回空，清单只剩"系统默认" —— 功能消失，但不出错。

## 不采纳的方案

- **打包 webfont（`go:embed` 一份 woff2）**。不破单二进制（[ADR-0002](0002-self-contained-binary.md)），
  但一套字重就是几百 KB，而中英对齐真正要的 CJK 等宽（Sarasa Mono SC）是 10 MB 级 ——
  体积上不封顶，还得处理首屏 FOUT。系统字体这两个问题都没有。
- **让用户自己填字体名。** 填错了静默回退，用户看不出为什么没生效；填一个比例字体
  （Arial）进去，整个终端的列对齐当场塌掉 —— 这是个不可见的坑，而清单天然堵死它。
- **按平台猜清单**（`navigator.platform` → 只列 macOS 那几个）。探测比猜准：用户装了
  什么，量一下就知道，不必猜。

## 后果

- 清单要人肉维护：新流行的编程字体得手动加一行 —— 成本就是一行。
- **连字不会生效。** Fira Code / JetBrains Mono 的 `->` `=>` 连字需要 xterm 的
  `addon-ligatures`，而它只在 DOM 渲染器下工作，我们用的是 WebGL（AC-5.5）。清单里因此
  优先收不带连字的变体（Cascadia Mono 而不是 Cascadia Code）；带连字的字体照样能选，
  只是显示成普通字形。**这一条必须写在设置面板里**，否则用户会当成 bug。
- 界面 chrome 的字体（`--font-ui`）不进这个设置。终端字体是内容，chrome 的字体是外壳，
  混成一个选项只会让"字体"在设置面板里含义不清。
