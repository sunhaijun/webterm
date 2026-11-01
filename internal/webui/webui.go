// Package webui embeds the built frontend.
//
// The agent serves the frontend itself; there is no separate frontend origin
// (invariant 2).
//
// dist/ is produced by `npm run build` and is not checked in. The all:dist
// pattern plus a placeholder .gitkeep keeps a clean checkout buildable;
// without the directory, go:embed fails and nothing compiles. If the frontend
// was never built, Built() is false and the HTTP layer says so explicitly
// instead of returning a puzzling 404.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the frontend build output, rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic("webui: dist not embedded: " + err.Error())
	}
	return sub
}

// Built reports whether the binary actually contains the frontend build.
func Built() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
