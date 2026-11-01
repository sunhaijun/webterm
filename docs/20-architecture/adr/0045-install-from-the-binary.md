# ADR-0045 The install script ships inside the binary

Status: Accepted (2026-10-31). Extended by [ADR-0046](0046-guided-install.md).

## Context

Setting up a new server had too many sharp edges:

1. The script came from `main` while the binary came from the latest release, so they could disagree: v0.1.0 doesn't reset sessions' OOM score, yet the newer script wrote a unit with `OOMScoreAdjust=-900`, leaving every session process at -900.
2. A private repository meant `gh auth login` on the server, leaving a token with access to all the owner's repositories on a machine that exposes a shell.
3. The staging dry run was broken (ADR-0044 §3) and took several manual steps.
4. The pre-install check couldn't detect the most common failure, a closed cloud firewall.
5. The installer didn't print a pairing code, though its header said it did.

## Decision

### 1. `webterm install` runs the embedded installer

`scripts/embed.go` embeds `scripts/install.sh`. `webterm install [args]` writes it to a temp file and runs it with `--binary <this executable>`, passing the terminal through.

```bash
scp webterm server: && ssh -t server ./webterm install
```

No download, no GitHub credentials. Running it again with a newer binary is an upgrade: the script already detects a running agent and hot-upgrades it (ADR-0016). The installer logic stays in one place, install.sh; Go only extracts and runs it.

### 2. A downloaded install.sh only downloads, then hands over

After verifying the SHA-256, a script fetched with `curl | bash` runs `<downloaded binary> install <original args>`, so the rest of the install is done by the script embedded in that exact binary. Binaries without `install` (v0.1.0 and older) are refused rather than installed by a mismatched script. A dry run downloads nothing and so doesn't hand over.

### 3. Default address

Without `--domain`: reuse `~/.config/webterm/install-state` if it exists (command-line arguments override), otherwise use the public IPv4 (ADR-0044), or ask (ADR-0046). `--dev` and `--no-service` need no address.

`domain`, `http-port` and `https-port` in the config file are synced on every install (rewritten, or removed when back to the default); other keys are left alone.

### 4. Get the certificate before starting the service: `webterm doctor --acme`

After the static checks, `--acme` binds both ports briefly and requests the production certificate into `certs/`, where the service finds it. If `certs/` already holds a valid certificate, it's used as is and the report says the CA wasn't contacted. This is the only check that proves, from inside the machine, that the CA can reach it (cloud firewall, NAT, ISP blocking port 80).

The installer runs it on fresh installs only, after `setcap` (so the binary can bind the ports) and before writing the unit. On failure it stops without installing the service; `--force` overrides. Upgrades skip it because the running agent holds the ports.

### 5. Local firewall

On fresh installs, if ufw is enabled (`/etc/ufw/ufw.conf`, world-readable) or firewalld is active, the installer opens both ports and says so. The cloud firewall is out of reach; §4 detects it.

### 6. Pair at the end: `webterm pair --wait`

A fresh install ends with `webterm pair --wait`: it waits up to 90 seconds until `127.0.0.1:<https-port>` serves a certificate the system trusts for `--domain`, then prints the pairing URL and QR code. On timeout it says where to look and prints the code anyway (valid for 5 minutes).

## Consequences

- No GitHub credentials on servers; `gh`/`GH_TOKEN` remain as a fallback for private forks.
- install.sh gains `--binary <path>`: use a local binary, skip download and checksum.
- Release assets include install.sh, so `curl -fsSL https://github.com/sunhaijun/webterm/releases/latest/download/install.sh | bash` installs the latest release.
