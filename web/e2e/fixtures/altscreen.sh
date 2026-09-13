#!/bin/bash
# 假的全屏 TUI —— 行为对齐实测到的 claude 2.1.270（ADR-0019 §背景）：
#
#   * 启动就进备用屏，`ESC[?1049h` 整个生命周期【只发这一次】
#   * 稳态是差分重画：绝对定位、不清屏、假设屏幕上已经有上一帧
#   * 只有 SIGWINCH 才整屏重画（`ESC[2J` + 全屏），FRAME 计数 +1
#   * 退出时回主屏
#
# 用法: altscreen.sh [快跑秒数] [完成标记文件]
#
# 【两段式】：先快跑几秒把环形缓冲顶掉好几轮（差分帧刻意做大，约 30 KB/s），
# 然后【转入空闲，一个字节都不产】—— E2E 才能干净地量出"切回来花了多少字节"。
# 真实的 AI CLI 也是这个形状：干活时刷屏，等人时安静。
# 快跑结束会 touch 那个标记文件，测试据此知道"积压已经超过窗口了"。

busy=${1:-5}
donefile=${2:-}
frame=0
tick=0

paint_all() {
    printf '\033[2J\033[H'
    printf '\033[1;1H== 假 TUI · 整屏重画 =='
    printf '\033[3;1HFRAME %03d' "$frame"
}

paint_diff() {
    # 不清屏，逐行绝对定位 —— 离开备用屏上下文就没有意义的那种字节
    local i
    for ((i = 5; i <= 14; i++)); do
        printf '\033[%d;1Hrow %02d  tick %06d  ....................................' "$i" "$i" "$tick"
    done
}

on_winch() {
    frame=$((frame + 1))
    paint_all
}

on_exit() {
    printf '\033[?1049l'
    exit 0
}

trap on_winch WINCH
trap on_exit TERM INT HUP

printf '\033[?1049h'
paint_all

start=$SECONDS
marked=0
while :; do
    if ((SECONDS - start < busy)); then
        tick=$((tick + 1))
        paint_diff
        # 后台 sleep + wait：trap 才能在等待期间立刻生效（前台 sleep 会把信号压到它结束）
        sleep 0.02 &
        wait $! 2>/dev/null
    else
        if ((marked == 0)); then
            marked=1
            [ -n "$donefile" ] && touch "$donefile"
        fi
        # 空闲：只等信号，不产字节
        sleep 3600 &
        wait $! 2>/dev/null
    fi
done
