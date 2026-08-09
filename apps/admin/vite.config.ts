/// <reference types="vitest/config" />

import { resolve } from 'node:path'
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// dev: 前端 :5174，/api 反代到 admin server :37378（同源 cookie/session 用 proxy 透传）
// prod: vite build 出 dist，admin server 直接 serve
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:37378',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
})
