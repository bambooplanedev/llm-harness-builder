import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  // serve accepts a browser request only when Origin equals http://<Host>, so the dev proxy must keep the browser's Host
  server: { proxy: { '/api': { target: 'http://127.0.0.1:7331', changeOrigin: false } } },
})
