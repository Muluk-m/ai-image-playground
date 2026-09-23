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
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      '@tanstack/react-query': resolve(__dirname, 'node_modules/@tanstack/react-query'),
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
    // main.tsx 用 top-level await 读 runtime-config.json 决定 API 基址；
    // vite 默认 target='modules'（ES2020）不支持 TLA，会构建失败。与 apps/web 同源同因。
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['src/__tests__/server/**'],
  },
})
