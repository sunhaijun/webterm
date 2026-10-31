# ADR-0033 终端行列自己算，不用 FitAddon

状态：已接受（2026-10-31）。改写 AC-3.11。触发时机（`ResizeObserver` 看到容器尺寸变了才算）、`resize` 的 100ms 防抖、列数一变 agent 重发快照，都不变。

## 背景

E2E-42 改用窗口变窄来改列数时暴露出一个问题：在 900px 宽的窗口里，**只改高度，列数也会在 104 和 103 之间来回变**。

原因在 xterm 5.5 的 DOM 渲染器（`DomRenderer._updateDimensions`）：

```
css.canvas.width = Math.round(device.canvas.width / dpr)    // 整行宽先取整
css.cell.width   = css.canvas.width / cols                   // 再除以【当前】列数
```

FitAddon 拿 `css.cell.width` 去除可用宽度。这个值随当前列数变：

| 当前列数 | `css.cell.width` | 877px 能放几列 |
|---|---|---|
| 104 | 877 / 104 = 8.4327 | 103.99… → **103** |
| 103 | 868 / 103 = 8.4272 | 104.07 → **104** |

字符本身宽 8.4287px，877px 实际能放 104 列。但在这个宽度上，每次 `fit()` 的结果都和上一次相反。行高（`css.cell.height`）也是同样的算法：`dpr` 不是整数时（很多手机都不是），某些高度上行数同样会翻。

后果：手机弹出软键盘时只改了高度，但只要宽度恰好落在翻转点上，列数也跟着变一下。agent 收到新的列数会重发快照，整屏重画一次（AC-2.22）。这个问题 main 上就有，E2E 原先用 1280px 宽，没落在翻转点上。

## 决策

**行列 = 可用尺寸 ÷ 稳定的字符格尺寸，向下取整。** 字符格尺寸取 `dimensions.device.cell.width / dpr` 和 `dimensions.device.cell.height / dpr`，它们来自字符测量，和当前行列无关。

- 可用尺寸的算法和 FitAddon 相同：父元素的宽高，减去 `.xterm` 的内边距，宽度再减去滚动条宽度。最小 2 列 1 行。
- 行列变了才 `resize`。
- 实现是 `term/terminal.ts` 里的一个小函数：纯计算部分是 `proposeSize`，可以单测；读 DOM 的部分和 FitAddon 一样，要读 xterm 的内部字段（`_core._renderService.dimensions`）。不再依赖 `@xterm/addon-fit`。

## 不采纳的方案

- **继续用 FitAddon，加滞回**（比如列数只差 1 且宽度没变就不改）。这是把症状压下去：宽度真的只差一列的时候，也会被它拦住。
- **给 xterm 提 patch。** 值得提，但不能等它发版。

## 后果

- 在翻转点附近，画布宽度（`列数 × 字符宽`，取整）可能比可用宽度多出不到半个像素。`.term` 有 4px 内边距，看不出来。
- AC-3.11 加上「容器尺寸不变时行列稳定，只改高度时列数不变」；新增 UT-fit-1；E2E-42 加 ⑤：窗口宽度在 860–940px 之间每 4px 取一个值，各只改一次高度，列数都不变。
