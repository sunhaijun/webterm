package agent

import (
	"net/http"
	"strconv"
)

// handleTranscript 回放某会话当前的 AI CLI 转录（ADR-0012 β；http-api.md §转录）。
//
// 重连 / 切会话时客户端用它补齐 transcript 消息漏掉的部分；之后靠 WS 推送增量。
func (a *Agent) handleTranscript(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseUint(r.URL.Query().Get("sid"), 10, 16)
	if err != nil || sid == 0 {
		a.writeError(w, http.StatusBadRequest, "bad_request", "sid 必须是 1..65535")
		return
	}
	snap, ok := a.transcripts.Snapshot(uint16(sid))
	if !ok {
		a.writeError(w, http.StatusNotFound, "not_found", "该会话没有转录")
		return
	}
	a.writeJSON(w, http.StatusOK, snap)
}
