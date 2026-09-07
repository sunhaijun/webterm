# webterm bash 集成
#
# 契约见 docs/30-protocol/shell-integration.md。一份脚本同时支撑四个功能：
# 命令历史、CWD 上报、输入模式自动切换、命令块视图的数据基础。
#
# 【绝不能让 shell 启动失败】。宁可没有集成，也不能没有终端（AC-7.7）。
# 所以整个安装过程包在 { …; } 2>/dev/null || true 里。

{

# 已经装过就不再装（避免 rcfile 与手动 eval 叠加）
if [ -z "${__webterm_installed:-}" ]; then
__webterm_installed=1

__webterm_version=1

# ---------- 能力探测 ----------

# 命令原文要 base64（原文可能含 BEL/ESC/换行，会破坏 OSC 结构）。
# 没有可用的编码器就放弃命令上报，其余功能照常。
if command -v base64 >/dev/null 2>&1; then
    __webterm_b64() { base64 | tr -d '\n'; }
elif command -v openssl >/dev/null 2>&1; then
    __webterm_b64() { openssl base64 -A; }
else
    __webterm_b64() { return 1; }
fi

# bash 4 以下没有可靠的 DEBUG trap 语义，降级为只上报 CWD 与 prompt 状态
__webterm_can_report_cmd=1
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    __webterm_can_report_cmd=0
fi

# ---------- 工具 ----------

# 以空格开头的命令不进 bash 历史，我们据此跳过上报（AC-6.2 / US-6.7）。
# 只【追加】，不动用户已有的设置。
case ":${HISTCONTROL:-}:" in
    *:ignorespace:* | *:ignoreboth:*) ;;
    *) HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac

# OSC 7 的负载要 percent-encode。用 LC_ALL=C 按【字节】遍历，
# 否则多字节字符会被按码点编码，Go 侧解出来就不是原路径了。
__webterm_urlencode() {
    local LC_ALL=C s=$1 out= c i
    for ((i = 0; i < ${#s}; i++)); do
        c=${s:i:1}
        case $c in
            [-_.~a-zA-Z0-9/]) out+=$c ;;
            *) printf -v c '%%%02X' "'$c"; out+=$c ;;
        esac
    done
    printf '%s' "$out"
}

__webterm_emit() { printf '\033]%s\a' "$1"; }

# ---------- 守卫标志 ----------
#
# __webterm_in_prompt：正处在 PROMPT_COMMAND 里。排在我们后面的用户函数
#   同样会触发 DEBUG trap，没有这个标志它们会被当成用户命令上报 ——
#   产生假的命令记录，并把输入模式误切到 Raw。
# __webterm_invoked：本命令行已上报过（一个命令行内只触发一次）。
# __webterm_last_histno：上次上报的历史编号。

__webterm_in_prompt=1
__webterm_invoked=0
__webterm_last_histno=

# ---------- preexec：命令即将执行 ----------

__webterm_preexec() {
    [ -n "${COMP_LINE:-}" ] && return          # 补全过程中，跳过
    [ "$__webterm_in_prompt" = 1 ] && return   # PROMPT_COMMAND 内部的命令
    [ "$__webterm_invoked" = 1 ] && return     # 一个命令行内只触发一次
    __webterm_invoked=1

    if [ "$__webterm_can_report_cmd" = 1 ]; then
        local raw histno line
        raw=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)   # "  512  go test ./..."
        histno=${raw%%[!0-9 ]*}
        histno=${histno//[[:space:]]/}
        line=${raw#*[0-9]  }

        # 编号没变 = 本命令没进历史（前导空格）→ 只发边界，不上报原文。
        #
        # 比【编号】而不是比原文：连着跑两次 make 的话原文是一样的，
        # 比原文会把第二次误判成"没进历史"而漏记。
        if [ -n "$histno" ] && [ "$histno" != "$__webterm_last_histno" ]; then
            __webterm_last_histno=$histno
            local b64
            if b64=$(printf '%s' "$line" | __webterm_b64 2>/dev/null) && [ -n "$b64" ]; then
                __webterm_emit "1701;cmd;$b64"   # 必须在 133;C 之前
            fi
        fi
    fi

    __webterm_emit "133;C"
}

# ---------- precmd：命令结束 + prompt 之前 ----------

__webterm_precmd() {
    local code=$?                 # 【必须第一行捕获】，否则会被函数内的命令覆盖
    __webterm_in_prompt=1

    if [ "$__webterm_invoked" = 1 ]; then
        __webterm_emit "133;D;$code"
    fi
    __webterm_invoked=0

    local cwd
    cwd=$(__webterm_urlencode "$PWD")
    __webterm_emit "7;file://${HOSTNAME:-localhost}${cwd}"

    __webterm_assert_ps1
    return $code                  # 不要吞掉退出码，用户的 PS1 可能在看它
}

# __webterm_unguard 必须是 PROMPT_COMMAND 链的【最后一项】：
# 排在我们后面的用户函数还在跑的时候，DEBUG trap 必须继续被屏蔽。
__webterm_unguard() { __webterm_in_prompt=0; }

# ---------- PS1 标记 ----------
#
# 包在 \[ \]（零宽区域）里，否则 readline 会把这些不可见字节算进行宽，
# 光标位置和换行都会错。

__webterm_assert_ps1() {
    # 某些 prompt 主题框架（starship / powerline / oh-my-bash）每次 prompt
    # 前都会重写 PS1，所以每次 precmd 都要重新断言，不能只在安装时设一次。
    case $PS1 in
        *'133;A'*) ;;
        *) PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]' ;;
    esac
}

# ---------- 安装钩子 ----------
#
# 【包装】而不是覆盖用户已有的配置。

# DEBUG trap：已有的话链式调用，不替换
__webterm_prev_debug=$(trap -p DEBUG 2>/dev/null)
if [ -n "$__webterm_prev_debug" ]; then
    __webterm_prev_debug=${__webterm_prev_debug#trap -- \'}
    __webterm_prev_debug=${__webterm_prev_debug%\' DEBUG}
    eval "__webterm_chain_debug() { $__webterm_prev_debug ; }" 2>/dev/null || \
        __webterm_chain_debug() { :; }
else
    __webterm_chain_debug() { :; }
fi
trap '__webterm_preexec; __webterm_chain_debug' DEBUG

# PROMPT_COMMAND：追加而不覆盖。bash 5.1+ 支持数组形式，要分别处理。
if [ "${BASH_VERSINFO[0]:-0}" -gt 5 ] || \
   { [ "${BASH_VERSINFO[0]:-0}" -eq 5 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 1 ]; }; then
    if [ "$(declare -p PROMPT_COMMAND 2>/dev/null | cut -c1-11)" = "declare -a " ]; then
        PROMPT_COMMAND=(__webterm_precmd "${PROMPT_COMMAND[@]}" __webterm_unguard)
    else
        PROMPT_COMMAND=(__webterm_precmd ${PROMPT_COMMAND:+"$PROMPT_COMMAND"} __webterm_unguard)
    fi
else
    PROMPT_COMMAND="__webterm_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __webterm_unguard"
fi

__webterm_assert_ps1

# ---------- 握手 ----------
#
# agent 10 秒内没收到它就把 integration 标成 inactive（AC-7.6）。
__webterm_emit "1701;hello;$__webterm_version"

fi

} 2>/dev/null || true
