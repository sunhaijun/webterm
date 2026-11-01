#!/bin/bash
# Deterministic output for byte-level comparisons (AC-2.1).
#
# It must be fully deterministic: no timestamps, random numbers, host names or
# $PWD, or two runs would differ anyway and the comparison would mean nothing.
#
# Usage: emit.sh <lines> [delay-ms-per-line] [mono]
#
# With "mono", one SGR (magenta) at the start and one reset at the end: a colored
# span across many frames, so the cut always lands inside it (E2E-2e).
#
# Deliberately covers ANSI colors (attribute bugs show when replay starts inside a
# colored span), CJK wide characters (unicode11 widths) and long lines (wrapping).

lines=${1:-100}
delay_ms=${2:-0}
mono=${3:-}

long=$(printf 'x%.0s' $(seq 1 120))

[ "$mono" = mono ] && printf '\033[35m'
for ((i = 1; i <= lines; i++)); do
    if [ "$mono" = mono ]; then
        printf 'line %05d 中文宽字符测试 %s\n' "$i" "$long"
    else
        color=$((30 + i % 8))
        printf '\033[%dmline %05d\033[0m 中文宽字符测试 %s\n' "$color" "$i" "$long"
    fi
    if [ "$delay_ms" -gt 0 ]; then
        # read as sleep: no fork per line
        read -rt "0.$(printf '%03d' "$delay_ms")" -u 9 || true
    fi
done 9< /dev/zero
[ "$mono" = mono ] && printf '\033[0m'

# The done marker must appear only in the output, never in the echoed command
# line; otherwise the wait would end as soon as the command is typed.
printf 'EMIT-%s\n' DONE
