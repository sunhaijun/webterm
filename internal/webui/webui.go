// Package webui 是前端产物的 go:embed 挂载点。
//
// 前端由 agent 自己提供，不引入独立前端域名（不变式 2）。m3 之前这里是一个
// 占位页 —— 有它才能在 m2 就把静态资源路由、CSP、Service Worker 的路径都跑通。
package webui

import (
	"embed"
	"io/fs"
)

//go:embed dist
var dist embed.FS

// FS 返回前端产物的文件系统（根为 dist/）。
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic("webui: dist 没有被嵌入: " + err.Error())
	}
	return sub
}
