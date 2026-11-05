# Development

For deployment, see [install.md](install.md). Contribution rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Prerequisites

| | Version | For |
|---|---|---|
| Go | 1.27+ | the agent |
| Node | 22+ | building the frontend, Vitest, Playwright |
| bash | any | session integration tests need a real shell |
| Python 3 | any | the doc link checker |

Node is a build-time dependency only; the result is one static binary.

## Build

```bash
make build        # frontend, then ./webterm
```

Order matters: the frontend build (`internal/webui/dist`) is the input to `go:embed`. Built the other way round, the binary runs but its home page says no frontend was embedded. Only `.gitkeep` is committed in that directory, and it must exist or nothing compiles.

## Test

The test layers are described in [strategy.md](../70-testing/strategy.md).

```bash
go vet ./... && go test ./...                    # unit + integration: real PTYs, SQLite, HTTP, WebSocket
cd web && npm run typecheck && npm test          # frontend unit tests, incl. protocol vectors shared with Go
cd web && npx playwright install chromium && npm run e2e   # real binary + real browser
python3 scripts/check-doc-links.py               # links and anchors in all Markdown
```

`make check` runs all but E2E.

### E2E setup

- **E2E runs the binary in the repo root.** `web/e2e/harness.ts` spawns `./webterm`, so rebuild (`make build`) after changing Go or frontend code.
- **Chromium needs system libraries** (`libnss3`, `libnspr4`): `npx playwright install --with-deps chromium`, or `sudo apt install libnss3 libnspr4`. Without sudo, unpack them locally:

  ```bash
  apt-get download libnspr4 libnss3
  for f in *.deb; do dpkg-deb -x "$f" ./root; done
  export LD_LIBRARY_PATH=$PWD/root/usr/lib/x86_64-linux-gnu    # in every new shell
  ```

  When they're missing, every test fails at browser launch; that's the environment, not your change.
- **Run the suites one at a time** on machines with less than 4 GB of RAM: Go tests start many PTYs and Playwright starts Chromium.

## Frontend with hot reload

```bash
./webterm serve --dev --data-dir /tmp/webterm-dev &   # agent on :8080; its own data dir, so it runs beside an installed service
cd web && npm run dev          # Vite on :5173, proxies /api, /auth and /ws to :8080
```

Open the pairing link from the agent's output with port 5173 instead of 8080.

## Releases

[`release.yml`](../../.github/workflows/release.yml) publishes two channels:

| Trigger | Result | Installed by |
|---|---|---|
| push to `main` | the rolling `dev` prerelease | `install.sh --channel dev` |
| `v*` tag | a release with generated notes | `install.sh` (default) |

Both run `make release`: cross-compile amd64 and arm64, copy install.sh, write SHA256SUMS, and assert a static binary (AC-8.1) with the frontend embedded (AC-8.2).

The version comes from `git describe --tags --dirty --match 'v[0-9]*'`, or `dev-<sha>` without a tag. `--match` matters: the lightweight `dev` tag can sit on the same commit as a release tag, and `git describe` would otherwise pick it. The workflow fails a release whose binary doesn't report the tag.

To release:

```bash
git tag -a v0.3.0 -m "webterm v0.3.0" origin/main && git push origin v0.3.0
```

Then download the published binary and check `webterm version`. Before tagging, run the parts of [manual-checklist.md](../70-testing/manual-checklist.md) that automation can't cover (real IMEs and keyboards, network changes, real Let's Encrypt, PWA install).
