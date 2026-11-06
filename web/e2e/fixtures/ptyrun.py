#!/usr/bin/env python3
"""Run a command on a PTY of a set size and relay stdin/stdout (E2E-47).

    ptyrun.py COLS ROWS -- command [args...]

Stands in for `ssh -t`: the command gets a terminal of that size. When stdin
closes, the command is hung up (SIGHUP), as sshd does when the connection
ends. Exits with the command's status.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main() -> int:
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    if sys.argv[3] != "--":
        raise SystemExit("usage: ptyrun.py COLS ROWS -- command [args...]")
    argv = sys.argv[4:]

    pid, fd = pty.fork()
    if pid == 0:
        # Size the terminal before the command can look at it.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvp(argv[0], argv)

    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    watching = [fd, stdin]
    while True:
        ready, _, _ = select.select(watching, [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(stdout, data)
        if stdin in ready:
            data = os.read(stdin, 65536)
            if data:
                os.write(fd, data)
            else:
                os.kill(pid, signal.SIGHUP)
                watching = [fd]
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
