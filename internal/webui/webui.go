// Package webui 是前端产物的 go:embed 挂载点。
//
// 前端由 agent 自己提供，不引入独立前端域名（不变式 2）。
//
// dist/ 的内容由 `npm run build` 生成，【不入库】。所以这里用 all:dist 加一个
// 占位的 .gitkeep，保证干净检出也能 go build —— 否则 embed 找不到目录，
// 整个仓库连编都编不过。没跑过前端构建时 Built() 为 false，HTTP 层会明说
// "前端未构建"，而不是安静地返回 404 让人猜。
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS 返回前端产物的文件系统（根为 dist/）。
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic("webui: dist 没有被嵌入: " + err.Error())
	}
	return sub
}

// Built 报告二进制里是否真的带了前端产物。
func Built() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
