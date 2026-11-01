import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  build: {
    // Output goes straight into the go:embed directory: the agent serves the frontend
    // itself, with no separate frontend origin (invariant 2)
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    // Readable output matters when debugging byte-level continuity issues
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
