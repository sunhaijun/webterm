# webterm build. Invariant: one static binary, no cgo (every target uses CGO_ENABLED=0).
# See docs/80-ops/development.md.

# --match is required: the rolling `dev` tag can sit on the same commit as a release
# tag, and without it git describe may label a release build "dev".
VERSION ?= $(shell git describe --tags --dirty --match 'v[0-9]*' 2>/dev/null || echo "dev-$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)")
LDFLAGS := -s -w -X main.version=$(VERSION)
RELEASE_DIR := release
PLATFORMS := amd64 arm64

.PHONY: all build web release clean test test-go test-web e2e check install

all: build

## build: build ./webterm for this machine (frontend included)
build: web
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o webterm ./cmd/webterm
	@echo "→ ./webterm  ($(VERSION))"

## web: build the frontend, which go:embed picks up — so it must run before go build
web:
	cd web && npm ci --no-audit --no-fund && npm run build

## release: cross-compile into release/ with install.sh and SHA256SUMS
release: web
	@rm -rf $(RELEASE_DIR) && mkdir -p $(RELEASE_DIR)
	@for arch in $(PLATFORMS); do \
		echo "  building linux/$$arch …"; \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch \
			go build -ldflags "$(LDFLAGS)" -o $(RELEASE_DIR)/webterm-linux-$$arch ./cmd/webterm || exit 1; \
	done
	@cp scripts/install.sh $(RELEASE_DIR)/install.sh
	@cd $(RELEASE_DIR) && sha256sum webterm-* install.sh > SHA256SUMS
	@echo
	@ls -lh $(RELEASE_DIR)
	@echo "→ $(RELEASE_DIR)/  ($(VERSION))"

## test: all unit and integration tests, one suite at a time (small machines run out of memory otherwise)
test: test-go test-web

test-go:
	go vet ./...
	go test ./... -count=1

test-web:
	cd web && npm run typecheck && npm test

## e2e: Playwright against the real binary
e2e: build
	cd web && npm run e2e

## check: run before opening a pull request
check: test
	gofmt -l . | grep -v '^$$' && { echo "the files above need gofmt"; exit 1; } || true
	python3 scripts/check-doc-links.py

clean:
	rm -rf $(RELEASE_DIR) webterm internal/webui/dist/assets internal/webui/dist/index.html
