import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  build: {
    // 产物直接进 go:embed 的挂载点 —— 前端由 agent 自己提供，
    // 不引入独立前端域名（不变式 2）
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    // 调试字节级连续性问题时，能看懂产物很重要
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
})
