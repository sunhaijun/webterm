# webterm 构建
#
# 不变式：单二进制、不引入 cgo。所有目标都走 CGO_ENABLED=0。
# 详见 docs/80-ops/development.md。

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
RELEASE_DIR := release
PLATFORMS := amd64 arm64

.PHONY: all build web release clean test test-go test-web e2e check install

all: build

## build: 构建本机二进制（含前端）
build: web
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o webterm ./cmd/webterm
	@echo "→ ./webterm  ($(VERSION))"

## web: 构建前端产物（go:embed 的输入）
#
# 【必须先于 go build】。反了的话嵌进去的是空目录，二进制跑起来会明说
# "没有嵌入前端产物"。
web:
	cd web && npm ci --no-audit --no-fund && npm run build

## release: 交叉编译到 release/，附 SHA256SUMS
release: web
	@rm -rf $(RELEASE_DIR) && mkdir -p $(RELEASE_DIR)
	@for arch in $(PLATFORMS); do \
		echo "  building linux/$$arch …"; \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch \
			go build -ldflags "$(LDFLAGS)" -o $(RELEASE_DIR)/webterm-linux-$$arch ./cmd/webterm || exit 1; \
	done
	@cd $(RELEASE_DIR) && sha256sum webterm-* > SHA256SUMS
	@echo
	@ls -lh $(RELEASE_DIR)
	@echo "→ $(RELEASE_DIR)/  ($(VERSION))"

## test: 跑全部测试。分开跑 —— 小内存机器上三套一起会触发低内存回收
test: test-go test-web

test-go:
	go vet ./...
	go test ./... -count=1

test-web:
	cd web && npm run typecheck && npm test

e2e: build
	cd web && npm run e2e

## check: 提 PR 之前跑这个
check: test
	gofmt -l . | grep -v '^$$' && { echo "以上文件未格式化"; exit 1; } || true
	python3 scripts/check-doc-links.py

clean:
	rm -rf $(RELEASE_DIR) webterm internal/webui/dist/assets internal/webui/dist/index.html
