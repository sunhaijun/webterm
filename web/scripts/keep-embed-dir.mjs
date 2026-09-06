// Vite 的 emptyOutDir 会把 dist/ 整个清掉，包括那个 .gitkeep。
//
// 但 .gitkeep 必须一直在：dist/ 的内容不入库（是构建产物），而 go:embed
// 找不到目录的话整个仓库连编都编不过。构建完补回来。
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../../internal/webui/dist/.gitkeep', import.meta.url), '')
