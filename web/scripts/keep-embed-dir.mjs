// Vite's emptyOutDir wipes dist/ entirely, .gitkeep included.
//
// .gitkeep must always exist: dist/ contents are build output and not committed, and
// go:embed fails the whole build if the directory is missing. Restore it after building.
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../../internal/webui/dist/.gitkeep', import.meta.url), '')
