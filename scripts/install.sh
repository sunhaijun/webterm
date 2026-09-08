#!/usr/bin/env bash
#
# webterm 一键安装
#
#   curl -fsSL https://raw.githubusercontent.com/sunhaijun/webterm/main/scripts/install.sh | bash -s -- --domain term.example.com
#
# 本地试用（不配 systemd、不动特权端口）：
#
#   curl -fsSL .../install.sh | bash -s -- --dev
#
# 【仓库是私有的时候】raw.githubusercontent 和 releases/download 都会 404
# （它们不带凭据）。这时候用 gh 取脚本，脚本自己也会用 gh 去下二进制：
#
#   gh api repos/sunhaijun/webterm/contents/scripts/install.sh \
#     -H 'Accept: application/vnd.github.raw' | bash -s -- --domain term.example.com
#
# 脚本会：下载对应架构的二进制 → 校验 SHA256 → 装到 /usr/local/bin →
# setcap 让普通用户能绑 443 → 生成 systemd user service → 启动并打出配对二维码。
#
# 部署前置条件见 docs/80-ops/install.md。

set -euo pipefail

REPO="${WEBTERM_REPO:-sunhaijun/webterm}"
CHANNEL="latest"
PREFIX="${WEBTERM_PREFIX:-/usr/local/bin}"
DOMAIN=""
DEV=0
SETUP_SERVICE=1
DO_SETCAP=1
DRY_RUN=0
FORCE=0
BASE_URL=""
HTTPS_PORT=443
HTTP_PORT=80

die() { printf '\033[31m错误\033[0m %s\n' "$*" >&2; exit 1; }
# needs_privileged_port 报告有没有用到 1024 以下的端口 —— 只有那时才需要 setcap
needs_privileged_port() { [ "$HTTPS_PORT" -lt 1024 ] || [ "$HTTP_PORT" -lt 1024 ]; }
# find_cap_tool 找 setcap / getcap。
#
# 【不能只查 PATH】：它们装在 /usr/sbin，而 Debian/Ubuntu 的普通用户 PATH
# 里没有 sbin。只用 command -v 会把"装了但不在 PATH 上"误判成"没装"，
# 于是静默跳过 setcap —— 装完看着成功，服务却绑不上 80，ACME 挑战过不去，
# 证书永远签不下来。这个失败很难往回追到这里。
find_cap_tool() {
    if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return 0; fi
    for d in /usr/sbin /sbin; do
        [ -x "$d/$1" ] && { printf '%s' "$d/$1"; return 0; }
    done
    return 1
}
# check_port 先把值验一遍。不验的话非数字会撞上 [ -lt ]，在 set -e 下
# 抛出的是一句 bash 内部错误，用户看不出是自己参数写错了。
check_port() {
    case "$2" in
        ''|*[!0-9]*) die "$1 需要一个数字，得到 \"$2\"" ;;
    esac
    [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || die "$1 超出范围（1-65535）：$2"
}
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
    if [ "$DRY_RUN" = 1 ]; then printf '    $ %s\n' "$*"; else "$@"; fi
}
# done_msg 只在真的做了事的时候报告 —— dry-run 里说"已完成"是误导
done_msg() { [ "$DRY_RUN" = 1 ] || info "$*"; }

usage() {
    cat <<'EOF'
用法: install.sh [选项]

  --domain <域名>    生产部署：配置域名并生成 systemd 服务
  --dev              本地试用：只装二进制，不配 systemd、不 setcap
  --channel <名字>   latest（默认）或 dev（main 的滚动构建）
  --version <tag>    指定版本，如 v0.1.0
  --prefix <目录>    安装位置，默认 /usr/local/bin
  --https-port <n>   HTTPS 端口，默认 443（被别的服务占了就换，如 8443）
  --http-port <n>    ACME 挑战 + 跳转端口，默认 80
  --no-service       装二进制但不配 systemd
  --no-setcap        不做 setcap（你自己解决特权端口的绑定权限）
  --force            前置自检不通过也继续装
  --dry-run          只打印将要执行的命令
  -h, --help         这段说明

私有仓库：裸 curl 拿不到 release 产物。脚本会自动改用凭据 ——
优先 gh（需要 gh auth login），否则读 GH_TOKEN / GITHUB_TOKEN。

生产部署的硬前置：一个域名、A/AAAA 记录指向本机、80 与 443 可用。
装好之后先跑 webterm doctor --domain <域名> 逐项检查。
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:?--domain 需要一个值}"; shift 2 ;;
        --dev) DEV=1; SETUP_SERVICE=0; DO_SETCAP=0; shift ;;
        --channel) CHANNEL="${2:?--channel 需要一个值}"; shift 2 ;;
        --version) CHANNEL="${2:?--version 需要一个值}"; shift 2 ;;
        --prefix) PREFIX="${2:?--prefix 需要一个值}"; shift 2 ;;
        --no-service) SETUP_SERVICE=0; shift ;;
        --no-setcap) DO_SETCAP=0; shift ;;
        --base-url) BASE_URL="${2:?--base-url 需要一个值}"; shift 2 ;;
        --https-port) HTTPS_PORT="${2:?--https-port 需要一个值}"; shift 2 ;;
        --http-port) HTTP_PORT="${2:?--http-port 需要一个值}"; shift 2 ;;
        --force) FORCE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知选项 $1（--help 看用法）" ;;
    esac
done

check_port --https-port "$HTTPS_PORT"
check_port --http-port "$HTTP_PORT"
[ "$HTTPS_PORT" != "$HTTP_PORT" ] || die "--https-port 和 --http-port 不能相同（都是 $HTTPS_PORT）"

# ---------- 1. 前置检查 ----------

step "1/6 检查环境"

[ "$(uname -s)" = "Linux" ] || die "webterm 目前只支持 Linux（当前 $(uname -s)）"

case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "不支持的架构 $(uname -m)。可以自己从源码构建，见 docs/80-ops/install.md" ;;
esac
info "平台: linux/$ARCH"

for cmd in curl sha256sum install; do
    command -v "$cmd" >/dev/null 2>&1 || die "缺少 $cmd"
done

if [ "$(id -u)" = 0 ] && [ "$DEV" = 0 ]; then
    # agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限。
    # 以 root 跑等于把 root shell 挂到公网。
    die "不要用 root 跑这个脚本。用普通用户运行，脚本会在需要时调 sudo。"
fi

if [ "$DEV" = 0 ] && [ "$SETUP_SERVICE" = 1 ] && [ -z "$DOMAIN" ]; then
    die "生产部署必须指定 --domain（ACME 与 Origin 校验都要用它）。
      本地试用请加 --dev。"
fi

if command -v bash >/dev/null 2>&1; then
    bash_major=$(bash -c 'echo ${BASH_VERSINFO[0]}')
    bash_minor=$(bash -c 'echo ${BASH_VERSINFO[1]}')
    if [ "$bash_major" -lt 4 ] || { [ "$bash_major" -eq 4 ] && [ "$bash_minor" -lt 4 ]; }; then
        info "注意: bash $bash_major.$bash_minor —— 低于 4.4，Composer 的多行提交会降级（终端本身照常可用）"
    fi
fi

# ---------- 2. 下载 ----------

step "2/6 下载"

# PORT_ARGS 只在非默认端口时出现 —— 单元文件里写一串默认值是噪音
PORT_ARGS=""
[ "$HTTP_PORT" = 80 ] || PORT_ARGS="$PORT_ARGS --http-port $HTTP_PORT"
[ "$HTTPS_PORT" = 443 ] || PORT_ARGS="$PORT_ARGS --https-port $HTTPS_PORT"

# EXT_URL 是用户实际要访问的地址。443 是默认端口，写出来是噪音；
# 不是 443 就必须带上，否则给出去的地址打不开。
if [ "$HTTPS_PORT" = 443 ]; then EXT_URL="https://$DOMAIN"; else EXT_URL="https://$DOMAIN:$HTTPS_PORT"; fi
if [ -n "$BASE_URL" ]; then
    URL_BASE="$BASE_URL"
elif [ "$CHANNEL" = "latest" ]; then
    URL_BASE="https://github.com/$REPO/releases/latest/download"
else
    URL_BASE="https://github.com/$REPO/releases/download/$CHANNEL"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BIN="webterm-linux-$ARCH"
info "来源: $URL_BASE/$BIN"

# gh_tag 把 --channel 翻成 release 的 tag（认证下载要指名 tag，没有
# "latest/download" 这种便利写法）。
gh_tag() {
    if [ "$CHANNEL" = "latest" ]; then
        gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null
    else
        printf '%s' "$CHANNEL"
    fi
}

# fetch_auth 用凭据下一个 release 产物。
#
# 【私有仓库必须走这条】：releases/download 和 raw.githubusercontent 都不带
# 凭据，私有仓库下一律 404 —— 哪怕这台机器本来有权限访问那个仓库。
# 优先用 gh（凭据已经在它手里，脚本不碰 token）；没有 gh 就读环境变量里的
# token，走 API 的 asset 端点。
fetch_auth() {
    local name="$1" out="$2" tag
    tag=$(gh_tag) || true
    [ -n "$tag" ] || return 1

    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        gh release download "$tag" --repo "$REPO" --pattern "$name" \
            --output "$out" --clobber >/dev/null 2>&1 && return 0
    fi

    local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
    [ -n "$token" ] || return 1
    local id
    id=$(curl -fsSL -H "Authorization: Bearer $token" \
        "https://api.github.com/repos/$REPO/releases/tags/$tag" 2>/dev/null \
        | grep -B 3 "\"name\": *\"$name\"" | grep -m1 '"id":' \
        | tr -dc '0-9') || return 1
    [ -n "$id" ] || return 1
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" \
        "https://api.github.com/repos/$REPO/releases/assets/$id" -o "$out" 2>/dev/null
}

# fetch 先试匿名（公开仓库 / --base-url），失败再试凭据。
fetch() {
    local name="$1" out="$2"
    curl -fsSL "$URL_BASE/$name" -o "$out" 2>/dev/null && return 0
    # --base-url 是用户自己的下载源，跟 GitHub 凭据无关，不做回退
    [ -z "$BASE_URL" ] || return 1
    fetch_auth "$name" "$out"
}

if [ "$DRY_RUN" = 1 ]; then
    info "(dry-run，跳过下载)"
else
    fetch "$BIN" "$TMP/$BIN" || die "下载失败。按可能性排查：
      1. 仓库是私有的 —— 裸 curl 拿不到。装个 gh 并 gh auth login，
         或者 export GH_TOKEN=<有 repo 读权限的 token> 再重跑
      2. 还没有正式 release —— 用 --channel dev 装 main 的滚动构建
      3. 自建下载源 —— 用 --base-url
      都不行就从源码构建：见 docs/80-ops/install.md"

    # ---------- 3. 校验 ----------
    step "3/6 校验 SHA256"
    if fetch SHA256SUMS "$TMP/SHA256SUMS"; then
        (cd "$TMP" && grep " $BIN\$" SHA256SUMS | sha256sum -c -) \
            || die "校验和不匹配。下载的文件可能被篡改或损坏，已中止。"
        info "校验通过"
    else
        # 装的是一个会暴露到公网的 shell，拿不到校验和就不该往下走
        die "取不到 SHA256SUMS，无法校验完整性，已中止。"
    fi
fi

# ---------- 4. 前置自检 ----------
#
# 【装之前就查】。以前只在装完提示"你可以跑一下 doctor"，等于没查 ——
# 用户装完启动失败才发现 DNS 没配、端口被占。这里用刚下载下来的二进制
# 直接跑，不通过就中止。
step "4/6 前置自检"

if [ "$DRY_RUN" = 1 ]; then
    info "(dry-run，跳过)"
elif [ "$DEV" = 1 ] || [ -z "$DOMAIN" ]; then
    info "本地模式，无需检查域名与端口"
elif systemctl --user is-active --quiet webterm 2>/dev/null; then
    # 升级路径：端口正被运行中的自己占着，doctor 的端口检查必然误报
    info "webterm 已在运行（这是一次升级），跳过 —— 端口正被它自己占着"
elif chmod +x "$TMP/$BIN" && "$TMP/$BIN" doctor --domain "$DOMAIN" $PORT_ARGS; then
    :
elif [ "$FORCE" = 1 ]; then
    info "有检查未通过，但指定了 --force，继续"
else
    die "前置条件未满足（见上面标 ✗ 的项）。修好之后重跑，或用 --force 强行继续。

      注意：「云安全组有没有放行 80」在机器内部【检查不出来】——
      要在别的机器上跑：  curl -sI http://$DOMAIN/
      超时就是没放行，那样证书签不下来。"
fi

# ---------- 5. 安装 ----------

step "5/6 安装到 $PREFIX"

SUDO=""
if [ ! -w "$PREFIX" ]; then
    command -v sudo >/dev/null 2>&1 || die "$PREFIX 不可写且没有 sudo"
    SUDO="sudo"
    info "需要 sudo 写入 $PREFIX"
fi

if [ "$DRY_RUN" = 1 ]; then
    run $SUDO install -m755 "$TMP/$BIN" "$PREFIX/webterm"
else
    $SUDO install -m755 "$TMP/$BIN" "$PREFIX/webterm"
fi

if [ "$DO_SETCAP" = 1 ] && ! needs_privileged_port; then
    # 端口都在 1024 以上，普通用户本来就能绑 —— 不该白给一个 capability
    info "端口 $HTTP_PORT/$HTTPS_PORT 都不是特权端口，跳过 setcap"
    DO_SETCAP=0
fi
if [ "$DO_SETCAP" = 1 ]; then
    SETCAP="$(find_cap_tool setcap)" || die "用到了特权端口（$HTTP_PORT/$HTTPS_PORT）但找不到 setcap。
      装上：  sudo apt install libcap2-bin   （或 dnf install libcap）
      或换成 1024 以上的端口：  --http-port 8080 --https-port 8443
      或 --no-setcap 自己解决绑定权限（authbind、iptables 转发之类）
      【不能就这么装下去】—— 普通用户绑不上 $HTTP_PORT，ACME 挑战过不去，
      证书签不下来，而服务看着是起来了。"
    # 让普通用户能绑 1024 以下的端口，不必以 root 运行。
    # 注意：capability 附在文件上，每次替换二进制都要重做。
    run $SUDO "$SETCAP" 'cap_net_bind_service=+ep' "$PREFIX/webterm"
    # 【验一下真落到文件上了】—— setcap 在不支持 xattr 的文件系统上
    # （某些 NFS、overlayfs）会成功返回却什么都没写。
    # 等到服务起不来才发现就太晚了。
    if [ "$DRY_RUN" != 1 ] && GETCAP="$(find_cap_tool getcap)"; then
        "$GETCAP" "$PREFIX/webterm" 2>/dev/null | grep -q cap_net_bind_service \
            || die "setcap 执行成功了，但 capability 没落到文件上 —— $PREFIX 所在的
      文件系统可能不支持 xattr。换个前缀（--prefix ~/.local/bin）或者
      改用 1024 以上的端口。"
    fi
    done_msg "已 setcap，可以用普通用户绑 $HTTP_PORT/$HTTPS_PORT"
fi

[ "$DRY_RUN" = 1 ] || info "版本: $("$PREFIX/webterm" version)"

# ---------- 写配置文件 ----------
#
# 有了它，pair / doctor / devices 都不用再重复 --domain --https-port。
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/webterm"
if [ -n "$DOMAIN" ]; then
    run mkdir -p "$CONFIG_DIR"
    if [ "$DRY_RUN" = 1 ]; then
        info "将写入 $CONFIG_DIR/config（domain=$DOMAIN$PORT_ARGS）"
    elif [ -f "$CONFIG_DIR/config" ]; then
        # 不覆盖用户改过的配置
        info "已存在 $CONFIG_DIR/config，保留不动"
    else
        {
            echo "# 由 scripts/install.sh 生成。键名就是 flag 名，去掉前面的 --。"
            echo "# 完整可用键见：webterm serve --help"
            echo "domain = $DOMAIN"
            [ "$HTTP_PORT" = 80 ] || echo "http-port = $HTTP_PORT"
            [ "$HTTPS_PORT" = 443 ] || echo "https-port = $HTTPS_PORT"
        } > "$CONFIG_DIR/config"
        info "已写入 $CONFIG_DIR/config"
    fi
fi

# ---------- 6. 服务 ----------

if [ "$SETUP_SERVICE" = 0 ]; then
    step "6/6 完成"
    cat <<EOF

已安装: $PREFIX/webterm

本地试跑（不需要域名、证书、root）：

    webterm serve --dev

    → http://127.0.0.1:8080
      stdout 会打出配对 URL 和二维码，浏览器点开就能用。

EOF
    exit 0
fi

step "6/6 配置 systemd user service"

UNIT_DIR="${WEBTERM_UNIT_DIR:-$HOME/.config/systemd/user}"
run mkdir -p "$UNIT_DIR"

if [ "$DRY_RUN" = 1 ]; then
    info "将写入 $UNIT_DIR/webterm.service，其中："
    info "  ExecStart=$PREFIX/webterm serve --domain $DOMAIN$PORT_ARGS"
else
    cat > "$UNIT_DIR/webterm.service" <<EOF
# 由 scripts/install.sh 生成。完整说明见 docs/80-ops/systemd.md。
#
# 刻意【不】启用 ProtectHome / ProtectSystem / NoNewPrivileges / PrivateTmp：
# 它们会连会话里的 shell 一起限制，而用户开 webterm 就是为了操作自己的文件；
# NoNewPrivileges 还会让 sudo 失效。沙箱化 shell 是自欺欺人 —— 用户本来就有
# 这台机器的 shell 权限。唯一有效的加固是以普通用户运行。
[Unit]
Description=webterm — browser terminal agent
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PREFIX/webterm serve --domain $DOMAIN$PORT_ARGS
Restart=on-failure
RestartSec=3

# 优雅关闭：给 agent 时间广播"即将重启"并关闭会话
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed

StandardOutput=journal
StandardError=journal
SyslogIdentifier=webterm

[Install]
WantedBy=default.target
EOF
    info "已写入 $UNIT_DIR/webterm.service"
fi

# 没有 linger，user service 会在最后一个登录会话结束时被杀掉 ——
# 而"不用登录就能访问"正是 webterm 的核心价值。
if command -v loginctl >/dev/null 2>&1; then
    run $SUDO loginctl enable-linger "$USER"
    done_msg "已 enable-linger（退出登录后服务继续运行）"
else
    info "没有 loginctl，跳过 linger。注意退出登录后服务可能被杀"
fi

run systemctl --user daemon-reload
run systemctl --user enable --now webterm

if [ "$DRY_RUN" = 1 ]; then
    step "完成（dry-run）"
    info "访问地址将是 $EXT_URL"
    info "配对命令：webterm pair（参数从配置文件读）"
    exit 0
fi

# 只在真的做了 setcap 时才提醒重做 —— 没做过的人看了只会困惑
if [ "$DO_SETCAP" = 1 ]; then
    SETCAP_NOTE="⚠  每次替换二进制之后要重做 setcap（capability 附在文件上，不在路径上）。
     重跑一次 install.sh 就会自动重做；手动的话：
     sudo $SETCAP 'cap_net_bind_service=+ep' $PREFIX/webterm
"
else
    SETCAP_NOTE=""
fi

step "完成"
cat <<EOF

服务已启动。接下来：

  访问地址：$EXT_URL

  webterm pair       拿配对码 + 二维码，手机扫一下完成授权
  webterm devices    看已授权的设备 / 吊销
  webterm doctor     再查一遍前置条件

  参数已写进 $CONFIG_DIR/config，上面的命令都不用带 --domain。
  看日志： journalctl --user -u webterm -f

$SETCAP_NOTE
EOF
