import react from '@vitejs/plugin-react'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

const EDGE_PROXY_TARGET = process.env.EDGE_PROXY_TARGET ?? 'http://localhost:8788'

/**
 * 把 dist/sw.js 中的 __BUILD_VERSION__ 占位符替换为每次构建唯一的 token。
 * SW 内 CACHE_NAME 用此 token，浏览器每次 fetch 到新 sw.js 时 byte 不同 →
 * install 新 SW → activate → clients.claim → 前端 controllerchange 监听到
 * → location.reload() 自动免强刷。
 */
function injectSwBuildVersion(): Plugin {
  return {
    name: 'inject-sw-build-version',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js')
      try {
        const content = readFileSync(swPath, 'utf-8')
        const buildId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
        writeFileSync(swPath, content.replace(/__BUILD_VERSION__/g, buildId))
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return // dist/sw.js 不存在（不应该），忽略
        throw err
      }
    },
  }
}

export default defineConfig(({ command }) => {
  const isServe = command === 'serve'
  const devProxyConfig = isServe ? loadDevProxyConfig() : null

  const proxy: Record<string, import('vite').ProxyOptions> = {}
  if (isServe) {
    // Edge channel routing: /api-proxy/<channelId>/* → wrangler pages dev (functions/).
    // Run alongside `pnpm dev` with `pnpm dev:edge`.
    proxy['/api-proxy'] = {
      target: EDGE_PROXY_TARGET,
      changeOrigin: true,
      secure: false,
    }
    // BYOK dev-proxy (optional, opt-in via dev-proxy.config.json). Same key
    // intentionally overrides the edge proxy if a tester points it here.
    if (devProxyConfig?.enabled) {
      proxy[devProxyConfig.prefix] = {
        target: devProxyConfig.target,
        changeOrigin: devProxyConfig.changeOrigin,
        secure: devProxyConfig.secure,
        rewrite: (path) =>
          path.replace(
            new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
            '',
          ),
      }
    }
  }

  return {
    plugins: [react(), injectSwBuildVersion()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy: Object.keys(proxy).length ? proxy : undefined,
    },
    build: {
      rollupOptions: {
        output: {
          // 拆出第三方依赖，缓解 500KB chunk warning + 让缓存复用率更高（首屏 vendor
          // 大概率不变，业务代码改动只 bust 业务 chunk）。用函数形式才能匹配
          // deep imports（react/jsx-runtime、react-dom/client 等）。
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'react-vendor'
            }
            if (id.includes('/zustand/')) return 'zustand'
            return undefined
          },
        },
      },
    },
  }
})
