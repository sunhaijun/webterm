#!/bin/bash
# 确定性输出脚本 —— 用于字节级比较（AC-2.1）。
#
# 必须【完全确定性】：不含时间戳、不含随机数、不含主机名、不含 $PWD。
# 否则两次运行的输出本来就不同，字节级比较毫无意义。
#
# 用法: emit.sh <总行数> [每行延迟ms]
#
# 内容刻意覆盖：ANSI 颜色（回放起点落在着色区间内时最容易暴露属性修正的
# bug）、CJK 宽字符（unicode11 宽度计算）、超长行（换行边界裁剪）。

lines=${1:-100}
delay_ms=${2:-0}

long=$(printf 'x%.0s' $(seq 1 120))

for ((i = 1; i <= lines; i++)); do
    color=$((30 + i % 8))
    printf '\033[%dmline %05d\033[0m 中文宽字符测试 %s\n' "$color" "$i" "$long"
    if [ "$delay_ms" -gt 0 ]; then
        # 用 read 做 sleep，避免每行 fork 一个进程
        read -rt "0.$(printf '%03d' "$delay_ms")" -u 9 || true
    fi
done 9< /dev/zero

# 完成标记必须【只出现在输出里】，不能出现在被回显的命令行里 ——
# 否则等待条件会在命令刚敲完时就满足，测的是回显而不是输出。
printf 'EMIT-%s\n' DONE
