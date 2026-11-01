#!/usr/bin/env bash
#
# webterm installer.
#
#   curl -fsSL https://github.com/sunhaijun/webterm/releases/latest/download/install.sh | bash
#   ./webterm install [--domain term.example.com]     # same script, embedded in the binary (ADR-0045)
#
# Without --domain it reuses the previous install's arguments, or asks (default:
# this server's public IPv4, which gets a Let's Encrypt IP certificate, ADR-0044).
#
# A script fetched from the network only downloads and verifies the binary, then
# hands over to that binary's `webterm install`, which runs the copy of this script
# embedded in it. Script and binary therefore always come from the same version.
#
# Steps: get the binary → install to /usr/local/bin and setcap → open the local
# firewall → obtain the certificate (guided: waits for you to fix the cloud firewall
# or DNS, ADR-0046) → write config and a systemd system service running as you
# (ADR-0034) → start → print a pairing QR code.

set -euo pipefail

REPO="${WEBTERM_REPO:-sunhaijun/webterm}"
CHANNEL="latest"
PREFIX="${WEBTERM_PREFIX:-/usr/local/bin}"
DOMAIN=""
DEV=0
SETUP_SERVICE=1
DO_SETCAP=1
IF_NEWER=0
WHEN_IDLE=0
FORCE_RESTART=0
PRINT_UNIT=0
DRY_RUN=0
FORCE=0
BASE_URL=""
HTTPS_PORT=443
HTTP_PORT=80
BINARY=""
ADDR_SOURCE=""
# Kept verbatim: handed to the downloaded binary and replayed after install-state.
ORIG_ARGS=("$@")

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
    if [ "$DRY_RUN" = 1 ]; then printf '    $ %s\n' "$*"; else "$@"; fi
}
# run_quiet is run, but swallows the command's own output (ufw and firewall-cmd are chatty).
run_quiet() {
    if [ "$DRY_RUN" = 1 ]; then printf '    $ %s\n' "$*"; else "$@" >/dev/null; fi
}
# done_msg reports work that was actually done; in a dry run nothing was.
done_msg() { [ "$DRY_RUN" = 1 ] || info "$*"; }
# have_tty: prompts read from /dev/tty, not stdin — under `curl | bash` stdin is the script.
have_tty() { ( : </dev/tty ) 2>/dev/null; }
needs_privileged_port() { [ "$HTTPS_PORT" -lt 1024 ] || [ "$HTTP_PORT" -lt 1024 ]; }
# find_cap_tool locates setcap/getcap. They live in /usr/sbin, which is not on a
# regular user's PATH on Debian/Ubuntu; missing them silently would leave a service
# that can't bind port 80 and never gets a certificate.
find_cap_tool() {
    if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return 0; fi
    for d in /usr/sbin /sbin; do
        [ -x "$d/$1" ] && { printf '%s' "$d/$1"; return 0; }
    done
    return 1
}
check_port() {
    case "$2" in
        ''|*[!0-9]*) die "$1 needs a number, got \"$2\"" ;;
    esac
    [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || die "$1 is out of range (1-65535): $2"
}

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --domain <addr>     Domain name or public IPv4. Default: the previous install's
                      settings, otherwise ask (Enter = this server's public IP)
  --https-port <n>    HTTPS port (default 443; e.g. 8443 if 443 is taken)
  --http-port <n>     Port for certificate validation and redirects (default 80)
  --dev               Local trial: install the binary only, no service, no setcap
  --binary <path>     Install this local binary instead of downloading
  --channel <name>    latest (default) or dev (rolling build of main)
  --version <tag>     Install a specific release, e.g. v0.2.0
  --prefix <dir>      Install directory (default /usr/local/bin)
  --no-service        Don't set up the systemd service
  --no-setcap         Don't grant the low-port capability (handle it yourself)
  --if-newer          Do nothing if this version is already installed
  --when-idle         Upgrade only once no session is running a command
  --force-restart     Restart instead of hot upgrade (closes all sessions);
                      also migrates an old user service to a system service
  --print-unit        Print the systemd unit and exit
  --force             Continue even if the certificate check fails
  --dry-run           Print what would be done
  -h, --help          Show this help

Requirements: Linux (x86_64/arm64), a non-root user with sudo, a public IPv4
(or a domain pointing to it), and inbound TCP 80/443 allowed by your cloud
firewall. The installer checks each of these and tells you what to fix.
EOF
}

# parse_args may run twice: when replaying install-state, the saved arguments come
# first and the command line second, so the command line wins.
parse_args() {
while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
        --binary) BINARY="${2:?--binary needs a value}"; shift 2 ;;
        --dev) DEV=1; SETUP_SERVICE=0; DO_SETCAP=0; shift ;;
        --channel) CHANNEL="${2:?--channel needs a value}"; shift 2 ;;
        --version) CHANNEL="${2:?--version needs a value}"; shift 2 ;;
        --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
        --no-service) SETUP_SERVICE=0; shift ;;
        --no-setcap) DO_SETCAP=0; shift ;;
        --if-newer) IF_NEWER=1; shift ;;
        --base-url) BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
        --https-port) HTTPS_PORT="${2:?--https-port needs a value}"; shift 2 ;;
        --http-port) HTTP_PORT="${2:?--http-port needs a value}"; shift 2 ;;
        --force) FORCE=1; shift ;;
        --when-idle) WHEN_IDLE=1; shift ;;
        --force-restart) FORCE_RESTART=1; shift ;;
        --print-unit) PRINT_UNIT=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $1 (see --help)" ;;
    esac
done
}
parse_args "$@"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/webterm"
STATE_FILE="$CONFIG_DIR/install-state"

# finish_args validates the final arguments and derives values from them. It runs
# again after resolve_address, which may change the address and ports.
finish_args() {
    check_port --https-port "$HTTPS_PORT"
    check_port --http-port "$HTTP_PORT"
    [ "$HTTPS_PORT" != "$HTTP_PORT" ] || die "--https-port and --http-port must differ (both are $HTTPS_PORT)"
    case "$DOMAIN" in
        *:*) die "--domain $DOMAIN is an IPv6 address; only IPv4 is supported. On an IPv6-only server, use a domain with an AAAA record." ;;
    esac
    # Only non-default ports go into the unit file.
    PORT_ARGS=""
    [ "$HTTP_PORT" = 80 ] || PORT_ARGS="$PORT_ARGS --http-port $HTTP_PORT"
    [ "$HTTPS_PORT" = 443 ] || PORT_ARGS="$PORT_ARGS --https-port $HTTPS_PORT"
    if [ "$HTTPS_PORT" = 443 ]; then EXT_URL="https://$DOMAIN"; else EXT_URL="https://$DOMAIN:$HTTPS_PORT"; fi
}
finish_args

# detect_public_ip asks two public services for this machine's IPv4.
# WEBTERM_PUBLIC_IP overrides it (tests run offline).
detect_public_ip() {
    local ip="${WEBTERM_PUBLIC_IP:-}" u
    if [ -z "$ip" ]; then
        command -v curl >/dev/null 2>&1 || return 1
        for u in https://api.ipify.org https://ifconfig.me; do
            ip=$(curl -4 -fsS --max-time 5 "$u" 2>/dev/null) && [ -n "$ip" ] && break
            ip=""
        done
    fi
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
    printf '%s' "$ip"
}

# ask_address prompts for the address on the terminal (ADR-0046). Enter accepts
# the detected public IP.
ask_address() {
    local ip="$1" ans
    printf '\n\033[1m%s\033[0m\n' "Which address will you open webterm at?"
    if [ -n "$ip" ]; then
        info "Press Enter to use this server's public IP ($ip),"
        info "or type a domain name whose A record points to it."
    else
        info "Couldn't detect this server's public IP."
        info "Type a domain name pointing to this server, or its public IPv4."
    fi
    while :; do
        printf '  > '
        IFS= read -r ans </dev/tty || ans=""
        ans="${ans//[[:space:]]/}"
        ans="${ans#http://}"; ans="${ans#https://}"; ans="${ans%%/*}"   # tolerate a pasted URL
        if [ -z "$ans" ] && [ -n "$ip" ]; then DOMAIN="$ip"; ADDR_SOURCE="this server's public IP"; return; fi
        if [ -n "$ans" ]; then DOMAIN="$ans"; ADDR_SOURCE=""; return; fi
    done
}

# resolve_address decides the address when --domain wasn't given (ADR-0045 §3):
#   1. a previous install exists (install-state) → reuse its arguments; the command line wins
#   2. otherwise ask on the terminal, defaulting to the public IPv4 (no terminal → use it)
# --dev and --no-service don't need an address.
resolve_address() {
    [ -z "$DOMAIN" ] && [ "$DEV" = 0 ] && [ "$SETUP_SERVICE" = 1 ] || return 0
    if [ -f "$STATE_FILE" ]; then
        local state=() line
        while IFS= read -r line; do
            case "$line" in ''|'#'*) continue ;; esac
            state+=("$line")
        done < "$STATE_FILE"
        parse_args "${state[@]}" "${ORIG_ARGS[@]}"
        ADDR_SOURCE="previous install, $STATE_FILE"
    fi
    # Still no address if the previous install was --dev or --no-service.
    [ -z "$DOMAIN" ] && [ "$DEV" = 0 ] && [ "$SETUP_SERVICE" = 1 ] || { finish_args; return 0; }
    local ip=""
    ip="$(detect_public_ip)" || ip=""
    if have_tty && [ "$DRY_RUN" != 1 ] && [ "$PRINT_UNIT" != 1 ]; then
        ask_address "$ip"
    elif [ -n "$ip" ]; then
        DOMAIN="$ip"
        ADDR_SOURCE="this server's public IP; pass --domain to use a domain"
    else
        die "No --domain given and couldn't detect this server's public IPv4 (asked api.ipify.org and ifconfig.me).
      Pass --domain <domain or public IPv4>."
    fi
    finish_args
}

# ---------- systemd unit (ADR-0034) ----------
#
# A system service that runs as you. Not a user service: the user manager can't set
# oom_score_adj below 100, so under memory pressure the agent — and with it every
# session — would be killed before your SSH login.
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"
RUN_UID="$(id -u)"
SYSTEM_UNIT="/etc/systemd/system/webterm.service"
USER_UNIT="$HOME/.config/systemd/user/webterm.service"

render_unit() {
    cat <<EOF
# Generated by webterm's install.sh. See docs/80-ops/systemd.md.
#
# System service running as $RUN_USER (ADR-0034). No ProtectHome/ProtectSystem/
# NoNewPrivileges/PrivateTmp: they would confine the shells you open, and
# NoNewPrivileges breaks sudo. Running as a regular user is the hardening that counts.
[Unit]
Description=webterm — browser terminal agent
Documentation=https://github.com/$REPO
After=network-online.target user@$RUN_UID.service
Wants=network-online.target user@$RUN_UID.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
ExecStart=$PREFIX/webterm serve --domain $DOMAIN$PORT_ARGS
Restart=on-failure
RestartSec=3

# For systemctl --user, journalctl --user and D-Bus tools inside sessions.
# The UID is literal: %U in a system unit is PID 1's UID (0), not User='s.
Environment=XDG_RUNTIME_DIR=/run/user/$RUN_UID
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$RUN_UID/bus

# The agent is the last thing the OOM killer picks; sessions run at 0.
# "continue": an OOM-killed process inside a session doesn't stop the unit.
OOMScoreAdjust=-900
OOMPolicy=continue

# Hot upgrade (ADR-0016): re-exec the new binary in place, sessions survive.
ExecReload=/bin/kill -USR2 \$MAINPID

# Give the agent time to tell clients it's restarting.
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed

StandardOutput=journal
StandardError=journal
SyslogIdentifier=webterm

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$PRINT_UNIT" = 1 ]; then
    [ "$(id -u)" != 0 ] || die "Don't run this as root: the unit's User= is whoever runs the script."
    resolve_address
    [ -n "$DOMAIN" ] || die "--print-unit needs an address (--domain, or a previous install)"
    render_unit
    exit 0
fi

do_reload() {
    if [ "$DRY_RUN" = 1 ]; then printf '    $ %s\n' "$PREFIX/webterm reload $*"; return 0; fi
    "$PREFIX/webterm" reload "$@"
}

# Read-only and unprivileged: is-active works for regular users.
system_unit_active() { systemctl is-active --quiet webterm 2>/dev/null; }
user_unit_active() { systemctl --user is-active --quiet webterm 2>/dev/null; }
service_active() { system_unit_active || user_unit_active; }
# inside_webterm_unit: are we running inside a webterm session? Migrating stops the
# user service, which would kill this session and the script with it. Checks the
# cgroup, not $WEBTERM_SESSION, which tmux panes may have inherited.
inside_webterm_unit() { grep -q '/webterm\.service$' /proc/self/cgroup 2>/dev/null; }
migrate_hint() {
    cat <<EOF

  ⚠  This server still runs webterm as a systemd user service, which the OOM killer
     picks before your login session (ADR-0034). Migrating to a system service
     closes all sessions once:

       webterm update --force-restart

     Run it over SSH, not inside webterm: stopping the user service ends that session.
EOF
}

# ---------- 1. Preflight ----------

resolve_address

# FRESH: nothing is running yet. Only then do we open the firewall, obtain the
# certificate up front, and print a pairing code. On upgrades the ports are busy
# with the running agent and the devices are already paired.
FRESH=0
if [ "$SETUP_SERVICE" = 1 ] && [ "$DEV" = 0 ] && ! service_active; then FRESH=1; fi

step "1/6 Checking this machine"

[ "$(uname -s)" = "Linux" ] || die "webterm runs on Linux only (this is $(uname -s))"

case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "Unsupported architecture $(uname -m). You can build from source: docs/80-ops/install.md" ;;
esac
info "Platform: linux/$ARCH"
if [ -n "$DOMAIN" ]; then
    if [ -n "$ADDR_SOURCE" ]; then info "Address:  $DOMAIN ($ADDR_SOURCE)"; else info "Address:  $DOMAIN"; fi
fi

# curl and sha256sum are only needed to download.
NEED_CMDS="install"
[ -n "$BINARY" ] || NEED_CMDS="curl sha256sum install"
for cmd in $NEED_CMDS; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing $cmd"
done

if [ "$(id -u)" = 0 ] && [ "$DEV" = 0 ]; then
    # Whoever the agent runs as is who an attacker becomes. As root, that's a root
    # shell on the internet.
    die "Don't run this as root. Run it as a regular user; it calls sudo when needed."
fi

SVC_SUDO=""
if [ "$SETUP_SERVICE" = 1 ] && [ "$DEV" = 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Installing the systemd service needs sudo.
      Without sudo: use --no-service and see \"Without sudo\" in docs/80-ops/systemd.md."
    # Fail now, not halfway through, if sudo will need a password and there's no
    # terminal to type it in (ssh without -t).
    if [ "$DRY_RUN" != 1 ] && ! sudo -n true 2>/dev/null && ! have_tty; then
        die "sudo will ask for your password, but there's no terminal. Use ssh -t:
      ssh -t <server> ./webterm install"
    fi
    SVC_SUDO="sudo"
fi

if command -v bash >/dev/null 2>&1; then
    bash_major=$(bash -c 'echo ${BASH_VERSINFO[0]}')
    bash_minor=$(bash -c 'echo ${BASH_VERSINFO[1]}')
    if [ "$bash_major" -lt 4 ] || { [ "$bash_major" -eq 4 ] && [ "$bash_minor" -lt 4 ]; }; then
        info "Note: bash $bash_major.$bash_minor has no bracketed paste; multi-line pastes run line by line"
    fi
fi

if [ "$FRESH" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    cat <<EOF

  One thing has to be done outside this server: allow inbound TCP $HTTP_PORT and
  $HTTPS_PORT in your cloud provider's firewall (security group). If it isn't open yet,
  the installer will stop at the certificate step and tell you where to do it.
EOF
fi

# ---------- 2. Get the binary ----------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BIN="webterm-linux-$ARCH"

if [ -n "$BINARY" ]; then
    step "2/6 Using local binary"
    [ -f "$BINARY" ] || die "--binary $BINARY doesn't exist"
    # Copy first: $BINARY may be $PREFIX/webterm itself, and install can't copy a file onto itself.
    cp "$BINARY" "$TMP/$BIN"
    chmod +x "$TMP/$BIN"
    "$TMP/$BIN" version >/dev/null 2>&1 || die "$BINARY doesn't run here: wrong architecture (this is linux/$ARCH) or a damaged file."
    info "$BINARY ($("$TMP/$BIN" version))"
elif [ "$DRY_RUN" = 1 ]; then
    step "2/6 Downloading"
    info "(dry run: skipped; a real run downloads, verifies, then hands over to the downloaded binary)"
else
    step "2/6 Downloading"

    if [ -n "$BASE_URL" ]; then
        URL_BASE="$BASE_URL"
    elif [ "$CHANNEL" = "latest" ]; then
        URL_BASE="https://github.com/$REPO/releases/latest/download"
    else
        URL_BASE="https://github.com/$REPO/releases/download/$CHANNEL"
    fi
    info "From: $URL_BASE/$BIN"

    # gh_tag turns --channel into a tag; authenticated downloads need an explicit tag.
    gh_tag() {
        if [ "$CHANNEL" = "latest" ]; then
            gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null
        else
            printf '%s' "$CHANNEL"
        fi
    }

    # fetch_auth downloads a release asset with credentials (for forks kept private):
    # gh if it's logged in, else GH_TOKEN / GITHUB_TOKEN via the API.
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

    # fetch tries anonymously first, then with credentials (never for --base-url).
    fetch() {
        local name="$1" out="$2"
        curl -fsSL "$URL_BASE/$name" -o "$out" 2>/dev/null && return 0
        [ -z "$BASE_URL" ] || return 1
        fetch_auth "$name" "$out"
    }

    fetch "$BIN" "$TMP/$BIN" || die "Download failed. Check:
      - network access to github.com
      - --version / --channel names an existing release
      - for a private repository: gh auth login, or export GH_TOKEN
      Or build from source: docs/80-ops/install.md"

    step "Verifying SHA-256"
    if fetch SHA256SUMS "$TMP/SHA256SUMS"; then
        (cd "$TMP" && grep " $BIN\$" SHA256SUMS | sha256sum -c -) \
            || die "Checksum mismatch: the download is corrupt or was tampered with. Aborting."
        info "Checksum OK"
    else
        # This binary will expose a shell to the internet; no checksum, no install.
        die "Couldn't fetch SHA256SUMS, so the download can't be verified. Aborting."
    fi

    # ---------- Hand over (ADR-0045 §2) ----------
    #
    # The rest is done by the script embedded in the binary we just downloaded.
    # Binaries without `install` (v0.1.0 and older) are refused: installing them with
    # this newer script writes a unit they don't understand.
    chmod +x "$TMP/$BIN"
    NEW_VER="$("$TMP/$BIN" version 2>/dev/null)" || die "The downloaded binary doesn't run on this machine (linux/$ARCH)."
    if ! "$TMP/$BIN" install --help >/dev/null 2>&1; then
        die "$NEW_VER predates this installer (it has no 'webterm install'). Install v0.2.0 or later, or use --channel dev."
    fi
    step "Handing over to $NEW_VER"
    # stdin from /dev/null: under curl | bash, stdin is this script, and a child
    # reading it would eat the rest. Prompts and sudo use /dev/tty.
    rc=0
    "$TMP/$BIN" install "${ORIG_ARGS[@]}" </dev/null || rc=$?
    exit "$rc"
fi

# ---------- Version check (--if-newer) ----------
#
# Reinstalling the same version would restart the service and kick everyone out,
# too high a price for "just checking for updates".
if [ "$IF_NEWER" = 1 ] && [ "$DRY_RUN" != 1 ] && [ -x "$PREFIX/webterm" ]; then
    chmod +x "$TMP/$BIN"
    NEW_VER="$("$TMP/$BIN" version 2>/dev/null || echo unknown-new)"
    OLD_VER="$("$PREFIX/webterm" version 2>/dev/null || echo unknown-old)"
    if [ "$NEW_VER" = "$OLD_VER" ] && [ "$NEW_VER" != unknown-new ]; then
        if [ "$SETUP_SERVICE" = 1 ] && [ -f "$USER_UNIT" ] && [ "$FORCE_RESTART" = 1 ]; then
            step "Already up to date; migrating to a system service (--force-restart)"
            info "$OLD_VER"
        else
            step "Already up to date"
            info "$OLD_VER — nothing changed, the service was not restarted"
            [ "$SETUP_SERVICE" = 1 ] && [ -f "$USER_UNIT" ] && migrate_hint
            exit 0
        fi
    else
        step "Update available"
        info "Installed  $OLD_VER"
        info "New        $NEW_VER"
    fi
fi

# ---------- Hot upgrade or restart (ADR-0016) ----------
#
# If the running agent supports handoff, `webterm reload` re-execs it in place and
# sessions survive; otherwise (old agent, or --force-restart) restart. The probe is
# read-only; in a dry run it asks the installed binary so the plan matches a real run.
if [ "$DRY_RUN" = 1 ]; then
    PROBE_BIN="$PREFIX/webterm"
else
    PROBE_BIN="$TMP/$BIN"
    chmod +x "$PROBE_BIN"
fi
SWITCH=restart
if [ "$SETUP_SERVICE" = 1 ] && [ "$FORCE_RESTART" != 1 ] && service_active \
    && [ -x "$PROBE_BIN" ] && "$PROBE_BIN" reload --probe >/dev/null 2>&1; then
    SWITCH=reload
fi

# ---------- User service → system service (ADR-0034) ----------
#
# Handoff can't cross systemd managers, so migrating always loses sessions. We never
# do that silently (ADR-0016 §3): a running, hot-upgradable user service is upgraded
# in place and the user is told how to migrate.
KEEP_USER_UNIT=0
MIGRATE=0
if [ "$SETUP_SERVICE" = 1 ] && [ -f "$USER_UNIT" ]; then
    if [ "$SWITCH" = reload ] && user_unit_active; then
        KEEP_USER_UNIT=1
    else
        MIGRATE=1
    fi
fi
if [ "$MIGRATE" = 1 ] && user_unit_active && inside_webterm_unit; then
    MSG="Migrating to a system service stops every webterm session, including the one
      running this script, so the migration would die halfway.
      Run the same command over SSH (or in a tmux started outside webterm)."
    [ "$DRY_RUN" = 1 ] || die "$MSG"
    info "Note (a real run would refuse): $MSG"
fi
if [ "$KEEP_USER_UNIT" = 1 ]; then
    JCTL="journalctl --user -u webterm"
else
    JCTL="journalctl -u webterm"
fi

if [ "$WHEN_IDLE" = 1 ] && [ "$DRY_RUN" != 1 ] && service_active; then
    if [ "$SWITCH" = reload ]; then
        : # handled by webterm reload --when-idle below
    elif "$TMP/$BIN" reload --wait-idle >/dev/null 2>&1; then
        info "All sessions are idle (--when-idle)"
    else
        info "The running agent is too old to report idleness; --when-idle has no effect"
    fi
fi

# ---------- 3. Install ----------

step "3/6 Installing to $PREFIX"

SUDO=""
# Try creating a missing user directory (e.g. ~/.local/bin) without sudo first.
[ -d "$PREFIX" ] || [ "$DRY_RUN" = 1 ] || mkdir -p "$PREFIX" 2>/dev/null || true
if [ ! -w "$PREFIX" ]; then
    command -v sudo >/dev/null 2>&1 || die "$PREFIX isn't writable and sudo is missing"
    SUDO="sudo"
fi

if [ "$DRY_RUN" = 1 ]; then
    run $SUDO install -m755 "$TMP/$BIN" "$PREFIX/webterm"
else
    $SUDO install -m755 "$TMP/$BIN" "$PREFIX/webterm"
fi

if [ "$DO_SETCAP" = 1 ] && ! needs_privileged_port; then
    info "Ports $HTTP_PORT/$HTTPS_PORT aren't privileged; no setcap needed"
    DO_SETCAP=0
fi
if [ "$DO_SETCAP" = 1 ]; then
    SETCAP="$(find_cap_tool setcap)" || die "Ports $HTTP_PORT/$HTTPS_PORT need setcap, which isn't installed.
      Install it:            sudo apt install libcap2-bin   (or: sudo dnf install libcap)
      Or use high ports:     --http-port 8080 --https-port 8443
      Or handle it yourself: --no-setcap"
    # Lets a regular user bind ports below 1024. The capability lives on the file,
    # so it has to be granted again every time the binary is replaced.
    run $SUDO "$SETCAP" 'cap_net_bind_service=+ep' "$PREFIX/webterm"
    # Some filesystems (certain NFS, overlayfs) accept setcap and store nothing.
    if [ "$DRY_RUN" != 1 ] && GETCAP="$(find_cap_tool getcap)"; then
        "$GETCAP" "$PREFIX/webterm" 2>/dev/null | grep -q cap_net_bind_service \
            || die "setcap succeeded but the capability isn't on the file; the filesystem
      under $PREFIX probably doesn't support xattrs. Try --prefix ~/.local/bin or ports above 1024."
    fi
    done_msg "Granted the capability to bind ports $HTTP_PORT/$HTTPS_PORT"
fi

[ "$DRY_RUN" = 1 ] || info "Installed $("$PREFIX/webterm" version)"

# ---------- 4. Firewall and certificate (ADR-0045 §4–5, ADR-0046) ----------
#
# After setcap and before starting the service: the installed binary can bind the
# ports and nothing else holds them. `doctor --acme` obtains the real certificate
# into certs/, where the service picks it up. With --guide it stops at whatever
# you need to fix (DNS record, cloud firewall), says what to do, and checks again.

# open_firewall opens the ports in ufw/firewalld if either is active. The cloud
# firewall is out of reach; the certificate step detects that one.
open_firewall() {
    local p opened=""
    # ufw.conf is world-readable; ufw lives in sbin, which sudo's secure_path includes.
    if [ -r /etc/ufw/ufw.conf ] && grep -q '^ENABLED=yes' /etc/ufw/ufw.conf; then
        for p in "$HTTP_PORT" "$HTTPS_PORT"; do
            run_quiet sudo ufw allow "$p/tcp"
        done
        opened="ufw"
    fi
    if systemctl is-active --quiet firewalld 2>/dev/null; then
        for p in "$HTTP_PORT" "$HTTPS_PORT"; do
            run_quiet sudo firewall-cmd --permanent --add-port="$p/tcp"
        done
        run_quiet sudo firewall-cmd --reload
        opened="${opened:+$opened and }firewalld"
    fi
    if [ -n "$opened" ]; then
        done_msg "Opened TCP $HTTP_PORT and $HTTPS_PORT in $opened"
    else
        info "No local firewall (ufw/firewalld) is active"
    fi
}

if [ "$FRESH" = 1 ]; then
    step "4/6 Opening the firewall and getting a certificate"
    open_firewall
    # Ports are passed explicitly: an old config file may still name other ones.
    DOCTOR=("$PREFIX/webterm" doctor --acme --domain "$DOMAIN" --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT")
    have_tty && DOCTOR+=(--guide)
    if [ "$DRY_RUN" = 1 ]; then
        run "${DOCTOR[@]}"
    elif "${DOCTOR[@]}"; then
        :
    elif [ "$FORCE" = 1 ]; then
        info "The check failed; continuing because of --force"
    else
        die "Not installed: the check above failed. Fix what it says and run the same command again."
    fi
elif [ "$SETUP_SERVICE" = 1 ] && [ "$DEV" = 0 ]; then
    step "4/6 Checks"
    info "webterm is already running (upgrade); its ports and certificate are in use, skipping"
fi

# ---------- 5. Config file ----------
#
# Lets pair/doctor/devices work without repeating --domain/--https-port. Address and
# ports are synced on every install; other keys you added are left alone.
CONFIG_FILE="$CONFIG_DIR/config"

# config_set KEY VALUE rewrites the line for KEY, deletes it if VALUE is empty,
# or appends it. Accepts the forms the config parser accepts (leading spaces, --, bare key).
config_set() {
    local key="$1" val="$2" re
    re="^[[:space:]]*-*$key[[:space:]]*(=.*)?\$"
    if grep -qE "$re" "$CONFIG_FILE"; then
        if [ -n "$val" ]; then
            sed -i -E "s|$re|$key = $val|" "$CONFIG_FILE"
        else
            sed -i -E "/$re/d" "$CONFIG_FILE"
        fi
    elif [ -n "$val" ]; then
        printf '%s = %s\n' "$key" "$val" >> "$CONFIG_FILE"
    fi
}

if [ -n "$DOMAIN" ]; then
    [ "$SETUP_SERVICE" = 1 ] && step "5/6 Writing the config"
    if [ "$DRY_RUN" = 1 ]; then
        info "Would update $CONFIG_FILE (domain=$DOMAIN$PORT_ARGS; other keys untouched)"
    else
        mkdir -p "$CONFIG_DIR"
        if [ ! -f "$CONFIG_FILE" ]; then
            {
                echo "# webterm config. Keys are the flags of 'webterm serve --help' without the leading --."
                echo "# The installer keeps domain/http-port/https-port in sync; it never touches other keys."
            } > "$CONFIG_FILE"
        fi
        config_set domain "$DOMAIN"
        if [ "$HTTP_PORT" = 80 ]; then config_set http-port ""; else config_set http-port "$HTTP_PORT"; fi
        if [ "$HTTPS_PORT" = 443 ]; then config_set https-port ""; else config_set https-port "$HTTPS_PORT"; fi
        info "Updated $CONFIG_FILE (domain=$DOMAIN$PORT_ARGS)"
    fi
fi

# ---------- Install state ----------
#
# `webterm update` and a bare `webterm install` replay these arguments. One argument
# per line, exactly as on the command line, so replaying needs no mapping. Only the
# effective, persistent ones: --dry-run/--force/--if-newer are one-shot, and --dev is
# stored as its expansion (--no-service --no-setcap).
if [ "$DRY_RUN" = 1 ]; then
    info "Would write $STATE_FILE"
else
    mkdir -p "$CONFIG_DIR"
    {
        echo "# Written by webterm's install.sh; 'webterm update' reinstalls with these arguments."
        echo "# One argument per line."
        [ -n "$DOMAIN" ] && printf -- '--domain\n%s\n' "$DOMAIN"
        [ "$HTTPS_PORT" = 443 ] || printf -- '--https-port\n%s\n' "$HTTPS_PORT"
        [ "$HTTP_PORT" = 80 ] || printf -- '--http-port\n%s\n' "$HTTP_PORT"
        [ "$PREFIX" = /usr/local/bin ] || printf -- '--prefix\n%s\n' "$PREFIX"
        [ "$CHANNEL" = latest ] || printf -- '--channel\n%s\n' "$CHANNEL"
        [ "$SETUP_SERVICE" = 1 ] || echo "--no-service"
        [ "$DO_SETCAP" = 1 ] || echo "--no-setcap"
        true
    } > "$STATE_FILE"
fi

# ---------- 6. Service ----------

if [ "$SETUP_SERVICE" = 0 ]; then
    step "6/6 Done"
    if [ -n "$DOMAIN" ]; then
        cat <<EOF

Installed $PREFIX/webterm (no systemd service).

Start it yourself (the address is read from $CONFIG_FILE):

    webterm doctor --acme --guide     # check everything and get the certificate
    webterm serve

EOF
        exit 0
    fi
    cat <<EOF

Installed $PREFIX/webterm

Try it locally (no domain, certificate or root needed):

    webterm serve --dev     # → http://127.0.0.1:8080, prints a pairing link

EOF
    exit 0
fi

if [ "$KEEP_USER_UNIT" = 1 ]; then
    step "6/6 Hot upgrade (user service, unit unchanged)"
    IDLE_ARG=""
    [ "$WHEN_IDLE" = 1 ] && IDLE_ARG="--when-idle"
    if do_reload $IDLE_ARG; then
        done_msg "Upgraded in place, sessions kept: $("$PREFIX/webterm" version)"
    else
        die "The hot upgrade didn't complete; the old version is still running and sessions are fine.
      Why:                      $JCTL -n 50 --no-pager
      Restart and lose sessions: webterm update --force-restart"
    fi
    migrate_hint
else

step "6/6 Setting up the systemd service (runs as $RUN_USER)"

if [ "$MIGRATE" = 1 ]; then
    # Stop the user service first: both would fight over the same ports.
    info "Migrating from the user service: disabling and removing $USER_UNIT (closes its sessions)"
    run systemctl --user disable --now webterm || true
    run rm -f "$USER_UNIT"
    run systemctl --user daemon-reload || true
fi

if [ "$DRY_RUN" = 1 ]; then
    info "Would write $SYSTEM_UNIT (see --print-unit), including:"
    info "  User=$RUN_USER  OOMScoreAdjust=-900  OOMPolicy=continue"
    info "  ExecStart=$PREFIX/webterm serve --domain $DOMAIN$PORT_ARGS"
else
    render_unit | $SVC_SUDO tee "$SYSTEM_UNIT" >/dev/null
    info "Wrote $SYSTEM_UNIT"
fi

# The system service doesn't need lingering, but your user manager does: without it,
# systemctl --user and the session bus inside webterm vanish when you log out.
if command -v loginctl >/dev/null 2>&1; then
    run $SVC_SUDO loginctl enable-linger "$RUN_USER"
    done_msg "Enabled lingering for $RUN_USER"
else
    info "No loginctl; systemctl --user inside sessions may stop working after you log out"
fi

run $SVC_SUDO systemctl daemon-reload
run $SVC_SUDO systemctl enable webterm

if [ "$SWITCH" = reload ]; then
    # Hot upgrade (ADR-0016). If the new binary's preflight fails, the agent keeps
    # running the old version. Never fall back to a restart here: discovering later
    # that "kept" sessions are gone is worse than a clear failure.
    IDLE_ARG=""
    [ "$WHEN_IDLE" = 1 ] && IDLE_ARG="--when-idle"
    if do_reload $IDLE_ARG; then
        done_msg "Upgraded in place, sessions kept: $("$PREFIX/webterm" version)"
    else
        die "The hot upgrade didn't complete; the old version is still running and sessions are fine.
      Why:                      $JCTL -n 50 --no-pager
      Restart and lose sessions: webterm update --force-restart"
    fi
else

# restart, not `enable --now`: --now doesn't restart a running service, so an upgrade
# would leave the old binary running while reporting success. restart also starts a
# stopped service, so first installs use it too.
run $SVC_SUDO systemctl restart webterm

# Make sure it actually came up (e.g. a lost capability means a crash loop on port 80).
if [ "$DRY_RUN" != 1 ]; then
    ok=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if system_unit_active; then ok=1; break; fi
        sleep 0.5
    done
    [ "$ok" = 1 ] || die "The service didn't become active within 5 seconds. Logs:
      sudo journalctl -u webterm -n 30 --no-pager"
    done_msg "Service running: $("$PREFIX/webterm" version)"
fi
fi # SWITCH
fi # KEEP_USER_UNIT

if [ "$DRY_RUN" = 1 ]; then
    step "Done (dry run)"
    info "Address: $EXT_URL"
    exit 0
fi

SETCAP_NOTE=""
if [ "$DO_SETCAP" = 1 ]; then
    SETCAP_NOTE="  If you replace the binary by hand, grant the capability again:
    sudo $SETCAP 'cap_net_bind_service=+ep' $PREFIX/webterm
  (Re-running the installer does this for you.)
"
fi

step "Done"
cat <<EOF

  webterm is running at $EXT_URL

  webterm            status overview
  webterm pair       pair another device (also works from a paired device's session)
  $JCTL -f
$SETCAP_NOTE
EOF

# First install: the pairing QR code is the last thing on screen. --wait holds it
# back (up to 90 s) until HTTPS serves a trusted certificate, so scanning works.
if [ "$FRESH" = 1 ]; then
    "$PREFIX/webterm" pair --wait --domain "$DOMAIN" --https-port "$HTTPS_PORT" \
        || info "Couldn't print a pairing code; run: webterm pair"
fi
