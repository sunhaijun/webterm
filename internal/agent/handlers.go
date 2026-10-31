package agent

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/webui"
	"github.com/sunhaijun/webterm/internal/wsconn"
)

const maxJSONBody = 64 << 10

// ---------- 静态资源 ----------

// staticHandler 提供 go:embed 的前端产物。
//
// 静态资源【不认证】：JS/CSS 里没有秘密（所有数据都要走认证过的 API），
// 而给它加认证会导致登录页自己也需要认证的死循环。
func (a *Agent) staticHandler() http.Handler {
	sub := webui.FS()
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !webui.Built() {
			// 二进制里没带前端产物。安静地 404 会让人以为是路由坏了，
			// 直说是构建少了一步。
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("这个二进制没有嵌入前端产物。\n" +
				"构建顺序是：cd web && npm run build   然后再 go build\n"))
			return
		}
		// SPA 回退：未知路径交给 index.html，由前端路由处理
		p := r.URL.Path
		if p != "/" {
			if _, err := fs.Stat(sub, p[1:]); err != nil {
				r = r.Clone(r.Context())
				r.URL.Path = "/"
			}
		}
		// Service Worker 只缓存静态壳，这里不发长缓存头，避免更新推不下去
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

// ---------- 配对 ----------

type pairRequest struct {
	Code string `json:"code"`
}

// handlePair 是唯一一个未认证的动态入口，因此受限速保护（AC-1.6）。
func (a *Agent) handlePair(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	ip := auth.ClientIP(r, a.cfg.TrustProxy)

	if ok, retry := a.auth.Limiter().Allow(ip, now); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		a.writeError(w, http.StatusTooManyRequests, "rate_limited", "尝试过于频繁，请稍后再试")
		return
	}

	var req pairRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil || req.Code == "" {
		a.auth.Limiter().Failed(ip, now)
		a.writeError(w, http.StatusBadRequest, "bad_request", "缺少配对码")
		return
	}

	dev, token, err := a.auth.Pair(req.Code, r.Header.Get("User-Agent"), ip, now)
	if err != nil {
		if tripped := a.auth.Limiter().Failed(ip, now); tripped {
			// 全局熔断要让服务器上的人看见
			a.log.Warn("配对失败次数达到全局阈值，暂停接受配对 10 分钟")
		}
		// 日志里【绝不能】出现配对码（AC-8.5）
		a.log.Info("配对失败", "ip", ip)
		a.writeError(w, http.StatusUnauthorized, "invalid_code", "配对码无效或已过期")
		return
	}
	a.auth.Limiter().Succeeded(ip)
	a.auth.SetSessionCookie(w, token)
	a.log.Info("新设备完成配对", "device", dev.ID, "name", dev.Name, "ip", ip)
	a.writeJSON(w, http.StatusOK, map[string]any{"device": dev})
}

// ---------- WebSocket ----------

func (a *Agent) handleWS(w http.ResponseWriter, r *http.Request) {
	if !a.checkOrigin(r) {
		// 【一定要记下来】。走到这儿的请求已经过了认证，不是扫描器噪声，
		// 而是自己的设备被拒了。以前这里悄无声息，客户端表现成
		// "一直重试连接"，服务端日志一片空白，没法查。
		a.log.Warn("WebSocket 被拒：Origin 不符",
			"origin", r.Header.Get("Origin"), "expected", a.allowedOrigin())
		a.writeError(w, http.StatusForbidden, "forbidden", "Origin 与配置的域名不符")
		return
	}
	if a.hub.Full() {
		a.writeError(w, http.StatusServiceUnavailable, "too_many_conns", "并发连接数已达上限")
		return
	}
	dev := deviceFrom(r)

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin 已经在上面按配置域名严格校验过了
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled, // 不做压缩（ADR-0009）
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(int64(maxWSRead))

	c := wsconn.New(ws, wsconn.Deps{
		Sessions:        a.sessions,
		Hub:             a.hub,
		ServerVersion:   a.cfg.Version,
		Logger:          a.log,
		IdleTimeout:     a.cfg.WSIdleTimeout,
		WriteQueueBytes: a.cfg.WSWriteQueueMax,
		Revoked: func() bool {
			// 不能只在握手时检查 —— WebSocket 可能挂几天（AC-1.11）
			d, err := a.store.DeviceByToken(sessionTokenOf(r))
			return err == nil && d == nil
		},
	})
	if err := a.hub.Add(c); err != nil {
		_ = ws.Close(websocket.StatusTryAgainLater, "并发连接数已达上限")
		return
	}
	a.sessions.AddObserver(c)
	defer func() {
		a.sessions.RemoveObserver(c)
		a.hub.Remove(c)
	}()
	_ = dev
	c.Serve(r.Context())
}

func sessionTokenOf(r *http.Request) string {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		return c.Value
	}
	return ""
}

// maxWSRead 是单条 WebSocket 消息的读上限：帧头 + payload 上限，再留一点余量。
const maxWSRead = 12 + (256 << 10) + 1024

// ---------- 设备 ----------

func (a *Agent) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devs, err := a.store.ListDevices()
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "读取设备列表失败")
		return
	}
	cur := deviceFrom(r)
	out := make([]map[string]any, 0, len(devs))
	for _, d := range devs {
		out = append(out, map[string]any{
			"id": d.ID, "name": d.Name, "created_at": d.CreatedAt,
			"last_seen_at": d.LastSeenAt, "last_ip": d.LastIP,
			// current 标出发起请求的那台，UI 对它二次确认，防止误踢自己
			"current": cur != nil && d.ID == cur.ID,
		})
	}
	a.writeJSON(w, http.StatusOK, out)
}

func (a *Agent) handlePatchDevice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil || body.Name == "" {
		a.writeError(w, http.StatusBadRequest, "bad_request", "缺少 name")
		return
	}
	if err := a.store.RenameDevice(r.PathValue("id"), body.Name); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "改名失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if err := a.store.RevokeDevice(r.PathValue("id"), time.Now()); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "吊销失败")
		return
	}
	a.log.Info("设备已吊销", "device", r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) handleRevokeAll(w http.ResponseWriter, r *http.Request) {
	n, err := a.store.RevokeAllDevices(time.Now())
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "吊销失败")
		return
	}
	a.auth.ClearSessionCookie(w) // 包括自己
	a.log.Warn("已吊销全部设备", "count", n)
	a.writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

// ---------- 工具 ----------

func (a *Agent) writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		a.log.Debug("写响应失败", "err", err)
	}
}

func (a *Agent) writeError(w http.ResponseWriter, status int, code, message string) {
	a.writeJSON(w, status, map[string]string{"code": code, "message": message})
}
