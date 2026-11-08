package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"syscall"

	"github.com/sunhaijun/webterm/internal/files"
)

// The file browser's routes (ADR-0059, http-api.md#files). Every one is
// authenticated; the writes also check Origin (registered in agent.go).
// Paths and names never reach the log, only operations and sizes.

// rawCSP makes a served file inert even when the browser renders it as a
// document: an opaque origin (sandbox), no cookie, no scripts (ADR-0059 §7).
const rawCSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"

func (a *Agent) handleFsList(w http.ResponseWriter, r *http.Request) {
	l, err := files.List(r.URL.Query().Get("path"), 0)
	if err != nil {
		a.fsError(w, "list", err)
		return
	}
	a.writeJSON(w, http.StatusOK, l)
}

func (a *Agent) handleFsRaw(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f, info, err := files.Open(q.Get("path"))
	if err != nil {
		a.fsError(w, "read", err)
		return
	}
	defer f.Close()
	name := filepath.Base(f.Name())
	ctype := files.ContentType(name)
	disp := "attachment"
	if q.Get("download") == "" && files.Inline(ctype) {
		disp = "inline"
	}
	if v := mime.FormatMediaType(disp, map[string]string{"filename": name}); v != "" {
		disp = v
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", disp)
	h.Set("Content-Security-Policy", rawCSP)
	// no-store: a viewed .env or key must not land in the browser's disk cache
	h.Set("Cache-Control", "no-store")
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, info.Size(), info.ModTime().UnixNano()))
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func (a *Agent) handleFsUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	path, size, err := files.Save(q.Get("dir"), q.Get("name"), r.Body)
	if err != nil {
		a.fsError(w, "upload", err)
		return
	}
	a.log.Debug("file browser upload saved", "bytes", size)
	a.writeJSON(w, http.StatusCreated, map[string]any{"path": path, "name": filepath.Base(path), "size": size})
}

func (a *Agent) handleFsMkdir(w http.ResponseWriter, r *http.Request) {
	var body struct{ Dir, Name string }
	if !a.decodeFsBody(w, r, &body) {
		return
	}
	p, err := files.Mkdir(body.Dir, body.Name)
	if err != nil {
		a.fsError(w, "mkdir", err)
		return
	}
	a.writeJSON(w, http.StatusCreated, map[string]any{"path": p})
}

func (a *Agent) handleFsRename(w http.ResponseWriter, r *http.Request) {
	var body struct{ Path, Name string }
	if !a.decodeFsBody(w, r, &body) {
		return
	}
	p, err := files.Rename(body.Path, body.Name, a.home())
	if err != nil {
		a.fsError(w, "rename", err)
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"path": p})
}

func (a *Agent) handleFsDelete(w http.ResponseWriter, r *http.Request) {
	if err := files.Remove(r.URL.Query().Get("path"), a.home()); err != nil {
		a.fsError(w, "delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) decodeFsBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		a.writeError(w, http.StatusBadRequest, "bad_request", "Malformed request")
		return false
	}
	return true
}

// fsError maps a file system error to the HTTP API's errors. Only
// unexpected failures are logged, and then without the path.
func (a *Agent) fsError(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, files.ErrBadPath):
		a.writeError(w, http.StatusBadRequest, "bad_request", "The path must be absolute")
	case errors.Is(err, files.ErrBadName), errors.Is(err, syscall.ENAMETOOLONG):
		a.writeError(w, http.StatusBadRequest, "bad_request", "Invalid name")
	case errors.Is(err, files.ErrNotDir):
		a.writeError(w, http.StatusBadRequest, "bad_request", "Not a folder")
	case errors.Is(err, files.ErrNotRegular), errors.Is(err, syscall.EISDIR), errors.Is(err, syscall.ENXIO), errors.Is(err, syscall.ENODEV):
		a.writeError(w, http.StatusBadRequest, "bad_request", "Not a regular file")
	case errors.Is(err, files.ErrRefused):
		a.writeError(w, http.StatusBadRequest, "bad_request", "Refusing to change that")
	case errors.Is(err, files.ErrRead):
		a.log.Debug("file browser upload interrupted", "err", files.Reason(err))
		a.writeError(w, http.StatusBadRequest, "bad_request", "Upload interrupted")
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
		a.writeError(w, http.StatusNotFound, "not_found", "Not found")
	case errors.Is(err, fs.ErrPermission), errors.Is(err, syscall.EROFS):
		a.writeError(w, http.StatusForbidden, "forbidden", "Permission denied")
	case errors.Is(err, fs.ErrExist), errors.Is(err, syscall.ENOTEMPTY):
		a.writeError(w, http.StatusConflict, "exists", "That name is taken")
	default:
		a.log.Warn("file browser "+op+" failed", "err", files.Reason(err))
		a.writeError(w, http.StatusInternalServerError, "internal", "Failed")
	}
}
