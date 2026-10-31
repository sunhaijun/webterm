"""E2E-44 夹具：备用屏 + 鼠标跟踪（SGR）的假全屏程序。

显示 L001…L300 里的一屏（起始在最底下），每收到一次滚轮按 N 行滚动
（argv[1]，默认 5 = tmux copy-mode 的步长）。q 或 Ctrl-C 退出。
"""
import os
import re
import sys
import termios
import tty

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5
TOTAL = 300
rows = os.get_terminal_size().lines
top = TOTAL - rows  # 第一行显示的是 L(top + 1)
fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
out = sys.stdout


def draw():
    out.write('\x1b[H' + '\r\n'.join('\x1b[2KL%03d' % (top + i + 1) for i in range(rows)))
    out.flush()


out.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
draw()
pending = b''
try:
    while True:
        data = os.read(fd, 4096)
        if not data or b'\x03' in data or b'q' in data:
            break
        pending += data
        last = 0
        for m in re.finditer(rb'\x1b\[<(\d+);\d+;\d+[Mm]', pending):
            last = m.end()
            button = int(m.group(1))
            if button == 64:
                top = max(0, top - N)
            elif button == 65:
                top = min(TOTAL - rows, top + N)
        pending = pending[last:][-64:]
        draw()
finally:
    out.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')
    out.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
