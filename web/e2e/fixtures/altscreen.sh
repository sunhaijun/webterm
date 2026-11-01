#!/bin/bash
# A fake full-screen TUI that behaves like claude 2.1.270 as measured (ADR-0019, Context):
#
#   * enters the alternate screen at start; `ESC[?1049h` is sent exactly once
#   * steady state is differential redraws: absolute positioning, no clear, relies on the previous frame
#   * only SIGWINCH triggers a full redraw (`ESC[2J` + whole screen) and bumps FRAME
#   * returns to the main screen on exit
#
# Usage: altscreen.sh [busy-seconds] [done-marker-file]
#
# Two phases: run busy for a few seconds, overflowing the ring buffer several times
# (frames are deliberately large, ~30 KB/s), then go idle and emit nothing, so E2E
# can measure exactly how many bytes switching back costs. Real AI CLIs look like
# this: busy while working, silent while waiting. The marker file is touched when
# the busy phase ends, telling the test the backlog now exceeds the window.

busy=${1:-5}
donefile=${2:-}
frame=0
tick=0

paint_all() {
    printf '\033[2J\033[H'
    printf '\033[1;1H== fake TUI · full redraw =='
    printf '\033[3;1HFRAME %03d' "$frame"
}

paint_diff() {
    # No clear, absolute positioning per row: bytes that mean nothing outside the alternate screen
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
        # sleep in the background + wait, so the trap fires immediately (a foreground sleep delays signals)
        sleep 0.02 &
        wait $! 2>/dev/null
    else
        if ((marked == 0)); then
            marked=1
            [ -n "$donefile" ] && touch "$donefile"
        fi
        # Idle: wait for signals, emit nothing
        sleep 3600 &
        wait $! 2>/dev/null
    fi
done
