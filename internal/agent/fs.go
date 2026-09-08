package agent

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// fsItem 是路径补全的一项。
type fsItem struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

type fsResult struct {
	Items []fsItem `json:"items"`
}

// fsMaxItems 一次最多返回多少条。chips 一排放不下十几个，再多也没人翻。
const fsMaxItems = 50

// handleFS 是写态路径 chip 的数据源（ADR-0011 ③；http-api.md §路径补全）。
//
// 权限与 shell 相同：能配对进来的人本来就能在会话里 `ls` 任何目录，
// 这里不多给也不少给，所以不做目录白名单。
func (a *Agent) handleFS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cwd := q.Get("cwd")
	if !filepath.IsAbs(cwd) {
		a.writeError(w, http.StatusBadRequest, "bad_request", "cwd 必须是绝对路径")
		return
	}
	home, _ := os.UserHomeDir()
	a.writeJSON(w, http.StatusOK, completePath(cwd, q.Get("path"), home))
}

// completePath 列出 partial 所指目录里、以其最后一段为前缀的条目。
//
//   - partial 为空或以 / 结尾：列那个目录本身
//   - 相对路径基于 cwd；~ 展开成 home
//   - 点开头的隐藏项只在用户自己敲了 . 时出现
//   - 目录排前面，各自按名字排；符号链接按指向判断是不是目录
//   - 目录不存在 / 没权限 / 不是目录 → 空列表。敲路径的过程中这是常态，不是错
func completePath(cwd, partial, home string) fsResult {
	res := fsResult{Items: []fsItem{}}
	typedDir, base := splitPartial(partial)
	dir := expandHome(typedDir, home)
	switch {
	case dir == "":
		dir = cwd
	case !filepath.IsAbs(dir):
		dir = filepath.Join(cwd, dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return res
	}
	showHidden := strings.HasPrefix(base, ".")
	var dirs, files []fsItem
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, base) {
			continue
		}
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(dir, name)); err == nil {
				isDir = st.IsDir()
			}
		}
		if isDir {
			dirs = append(dirs, fsItem{Name: name, Dir: true})
		} else {
			files = append(files, fsItem{Name: name})
		}
	}
	// ReadDir 已按名字排好；这里只是把目录提到前面
	items := append(dirs, files...)
	if len(items) > fsMaxItems {
		items = items[:fsMaxItems]
	}
	if items != nil {
		res.Items = items
	}
	return res
}

// splitPartial 把 "src/co" 拆成 ("src/", "co")，"src/" 拆成 ("src/", "")，"co" 拆成 ("", "co")。
func splitPartial(partial string) (typedDir, base string) {
	i := strings.LastIndex(partial, "/")
	if i < 0 {
		return "", partial
	}
	return partial[:i+1], partial[i+1:]
}

// expandHome 把开头的 ~ 换成 home；home 未知就原样返回。
func expandHome(p, home string) string {
	if home == "" {
		return p
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		return home + p[1:]
	}
	return p
}
