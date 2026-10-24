import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webPort = Number(process.env.JOBDUCK_DEV_WEB_PORT ?? 5173)
const apiTarget = process.env.JOBDUCK_API_TARGET ?? 'http://127.0.0.1:4858'
const apiOrigin = new URL(apiTarget).origin
const devOrigins = new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`])

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (devOrigins.has(req.headers.origin ?? '')) proxyReq.setHeader('origin', apiOrigin)
          })
        },
      },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../src/dashboard/public'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? 'style.css' : '[name][extname]'),
      },
    },
  },
})
