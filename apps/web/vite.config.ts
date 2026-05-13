import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
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
    plugins: [react()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy: Object.keys(proxy).length ? proxy : undefined,
    },
  }
})
