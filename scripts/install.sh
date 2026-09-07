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
BASE_URL=""

die() { printf '\033[31m错误\033[0m %s\n' "$*" >&2; exit 1; }
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
  --no-service       装二进制但不配 systemd
  --no-setcap        不做 setcap（你自己解决 443 端口权限）
  --dry-run          只打印将要执行的命令
  -h, --help         这段说明

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
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知选项 $1（--help 看用法）" ;;
    esac
done

# ---------- 1. 前置检查 ----------

step "1/5 检查环境"

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

step "2/5 下载"

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

if [ "$DRY_RUN" = 1 ]; then
    info "(dry-run，跳过下载)"
else
    curl -fSL --progress-bar "$URL_BASE/$BIN" -o "$TMP/$BIN" || die "下载失败。
      如果还没有 release，可以用 --channel dev 装 main 的滚动构建，
      或者从源码构建：见 docs/80-ops/install.md"

    # ---------- 3. 校验 ----------
    step "3/5 校验 SHA256"
    if curl -fsSL "$URL_BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
        (cd "$TMP" && grep " $BIN\$" SHA256SUMS | sha256sum -c -) \
            || die "校验和不匹配。下载的文件可能被篡改或损坏，已中止。"
        info "校验通过"
    else
        # 装的是一个会暴露到公网的 shell，拿不到校验和就不该往下走
        die "取不到 SHA256SUMS，无法校验完整性，已中止。"
    fi
fi

# ---------- 4. 安装 ----------

step "4/5 安装到 $PREFIX"

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

if [ "$DO_SETCAP" = 1 ]; then
    if command -v setcap >/dev/null 2>&1; then
        # 让普通用户能绑 80/443，不必以 root 运行。
        # 注意：capability 附在文件上，每次替换二进制都要重做。
        run $SUDO setcap 'cap_net_bind_service=+ep' "$PREFIX/webterm"
        done_msg "已 setcap，可以用普通用户绑 80/443"
    else
        info "没有 setcap 命令，跳过。你需要自己解决 80/443 的绑定权限"
    fi
fi

[ "$DRY_RUN" = 1 ] || info "版本: $("$PREFIX/webterm" version)"

# ---------- 5. 服务 ----------

if [ "$SETUP_SERVICE" = 0 ]; then
    step "5/5 完成"
    cat <<EOF

已安装: $PREFIX/webterm

本地试跑（不需要域名、证书、root）：

    webterm serve --dev

    → http://127.0.0.1:8080
      stdout 会打出配对 URL 和二维码，浏览器点开就能用。

EOF
    exit 0
fi

step "5/5 配置 systemd user service"

UNIT_DIR="$HOME/.config/systemd/user"
run mkdir -p "$UNIT_DIR"

if [ "$DRY_RUN" = 1 ]; then
    info "将写入 $UNIT_DIR/webterm.service（--domain $DOMAIN）"
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
ExecStart=$PREFIX/webterm serve --domain $DOMAIN
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
    exit 0
fi

step "完成"
cat <<EOF

服务已启动。接下来：

  1. 检查部署前置条件（DNS、端口）
       webterm doctor --domain $DOMAIN

  2. 拿配对码（stdout 里有二维码，手机扫一下就完成授权）
       webterm pair

  3. 看日志
       journalctl --user -u webterm -f

⚠  第一次部署建议先用 --acme-staging 调通证书：
     systemctl --user stop webterm
     webterm serve --domain $DOMAIN --acme-staging
   正式环境的 Let's Encrypt 限流窗口是一周，撞上了只能等。

⚠  每次替换二进制之后要重做 setcap（capability 附在文件上，不在路径上）：
     sudo setcap 'cap_net_bind_service=+ep' $PREFIX/webterm

EOF
