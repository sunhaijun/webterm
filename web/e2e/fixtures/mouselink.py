"""E2E-49 fixture: a full-screen program with SGR mouse tracking that shows a URL.

Row 1 holds a URL, row 3 counts the mouse presses it received ("clicks: N"). q or Ctrl-C quits.
"""
import os
import re
import sys
import termios
import tty

fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
out = sys.stdout
clicks = 0


def draw():
    out.write('\x1b[H\x1b[2Kopen https://example.com/mouse here\r\n\r\n\x1b[2Kclicks: %d' % clicks)
    out.flush()


out.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J')
draw()
try:
    while True:
        data = os.read(fd, 4096)
        if not data or b'\x03' in data or b'q' in data:
            break
        clicks += len(re.findall(rb'\x1b\[<\d+;\d+;\d+M', data))
        draw()
finally:
    out.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')
    out.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
