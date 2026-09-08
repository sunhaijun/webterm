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
	"github.com/sunhaijun/webterm/internal/store"
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

// ---------- 命令历史 ----------

func (a *Agent) handleListCommands(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	f := store.Filter{
		Q:          q.Get("q"),
		Prefix:     q.Get("prefix"),
		CWD:        q.Get("cwd"),
		FailedOnly: q.Get("failed") == "true",
		PinnedOnly: q.Get("pinned") == "true",
		Limit:      limit,
		Before:     before,
	}
	items, err := a.store.ListCommands(f)
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "查询历史失败")
		return
	}
	resp := map[string]any{"items": items, "next_before": nil}
	// prefix 模式做了去重，不分页
	if n := len(items); n > 0 && (f.Limit == 0 || n >= f.Limit) && !f.PinnedOnly && f.Prefix == "" {
		resp["next_before"] = items[n-1].StartedAt
	}
	a.writeJSON(w, http.StatusOK, resp)
}

func (a *Agent) handleNewSnippet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text  string  `json:"text"`
		Label *string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil || body.Text == "" {
		a.writeError(w, http.StatusBadRequest, "bad_request", "缺少 text")
		return
	}
	id, err := a.store.NewSnippet(body.Text, body.Label, time.Now())
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "创建失败")
		return
	}
	a.writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (a *Agent) handlePatchCommand(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "id 非法")
		return
	}
	var body struct {
		Pinned   *bool   `json:"pinned"`
		Label    *string `json:"label"`
		PinOrder *int64  `json:"pin_order"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "请求体非法")
		return
	}
	if err := a.store.UpdateCommand(id, store.Patch{
		Pinned: body.Pinned, Label: body.Label, PinOrder: body.PinOrder,
	}); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "更新失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleReorderCommands 批量设置 pin_order。
//
// 一次事务提交所有受影响的项 —— 逐条提交会在中间态出现重复的 pin_order。
func (a *Agent) handleReorderCommands(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []struct {
			ID       int64 `json:"id"`
			PinOrder int64 `json:"pin_order"`
		} `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "请求体非法")
		return
	}
	order := make(map[int64]int64, len(body.Items))
	for _, it := range body.Items {
		order[it.ID] = it.PinOrder
	}
	if err := a.store.Reorder(order); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "排序失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) handleDeleteCommand(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "id 非法")
		return
	}
	if err := a.store.DeleteCommand(id); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "删除失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleClearCommands 清空全部非置顶历史。
//
// 必须带 pinned=false —— 不带参数的整表删除【不提供】，因为置顶记录承载着
// 快捷命令，误删不可恢复。
func (a *Agent) handleClearCommands(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("pinned") != "false" {
		a.writeError(w, http.StatusBadRequest, "bad_request",
			"必须显式带 pinned=false —— 整表删除不提供，置顶记录承载着快捷命令")
		return
	}
	deleted, kept, err := a.store.ClearHistory()
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "清空失败")
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted, "kept_pinned": kept})
}

// ---------- 设置 ----------

const settingHistoryEnabled = "history_enabled"

func (a *Agent) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{
		settingHistoryEnabled: a.historyEnabled(),
	})
}

func (a *Agent) handlePatchSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HistoryEnabled *bool `json:"history_enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "请求体非法")
		return
	}
	if body.HistoryEnabled != nil {
		if !a.sessions.HistoryConfigured() {
			// --no-history 是启动态覆盖：给了它就锁死为关闭，UI 上置灰
			a.writeError(w, http.StatusConflict, "locked_by_flag",
				"agent 以 --no-history 启动，历史记录已锁死为关闭")
			return
		}
		v := "false"
		if *body.HistoryEnabled {
			v = "true"
		}
		if err := a.store.SetSetting(settingHistoryEnabled, v); err != nil {
			a.writeError(w, http.StatusInternalServerError, "internal", "保存失败")
			return
		}
		a.sessions.SetHistoryEnabled(*body.HistoryEnabled)
	}
	a.handleGetSettings(w, r)
}

func (a *Agent) historyEnabled() bool {
	if !a.sessions.HistoryConfigured() {
		return false
	}
	v, ok, err := a.store.Setting(settingHistoryEnabled)
	if err != nil || !ok {
		return true
	}
	return v == "true"
}

// LoadSettings 启动时把持久化的设置装回去。
func (a *Agent) LoadSettings() {
	if a.sessions.HistoryConfigured() {
		a.sessions.SetHistoryEnabled(a.historyEnabled())
	}
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
