import react from '@vitejs/plugin-react'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { startupGuardPlugin } from './src/boot/vitePlugin'
import { normalizeDevProxyConfig } from './src/lib/devProxy'
import { pagesRedirectsPlugin } from './src/lib/pagesRedirects'
import { guideHtmlEntries, seoPlugin } from './src/seo/vitePlugin'
import { optionalFontsPlugin } from './src/styles/fontPlugin'
import { themeBootPlugin } from './src/theme/vitePlugin'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

/** 最低支持的浏览器内核。Chrome 80 覆盖仍在使用的国产浏览器旧内核；Safari 14 覆盖 iOS 14。 */
const BROWSER_TARGET = ['es2020', 'chrome80', 'edge80', 'firefox78', 'safari14']

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
    // BYOK dev-proxy (optional, opt-in via dev-proxy.config.json).
    // 用于本地调试 BYOK profile 时绕过上游 CORS 或加临时 header。
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
    plugins: [
      optionalFontsPlugin(),
      startupGuardPlugin(),
      react(),
      themeBootPlugin(),
      seoPlugin({ publicDir: resolve(__dirname, 'public') }),
      pagesRedirectsPlugin(),
      injectSwBuildVersion(),
    ],
    base: '/',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        react: resolve(__dirname, 'node_modules/react'),
        'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      host: true,
      proxy: Object.keys(proxy).length ? proxy : undefined,
    },
    // jSquash 用 `new URL('*.wasm', import.meta.url)` 找自己的 wasm；预打包会把路径改坏。
    optimizeDeps: { exclude: ['@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng'] },
    worker: { format: 'es' as const },
    test: {
      // i18n 初始化跟着 locale 走，测试里必须钉死，否则 jsdom 的 en-US 会把
      // 所有断言中文文案的历史用例打红。
      setupFiles: ['./src/__tests__/setup/i18n.ts'],
    },
    build: {
      // Windows 上大量用户用 360/QQ/搜狗等国产浏览器，内核常停在 Chromium 80 多版本；
      // 构建产物的语法必须降到它们读得懂，否则主脚本解析失败，整页停在「工作台暂时无法打开」。
      // 运行时 API 的缺口由 `src/boot/polyfills.ts` 补。入口因此不能用顶层 await。
      target: BROWSER_TARGET,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          ...guideHtmlEntries(__dirname),
        },
        output: {
          // 拆出第三方依赖，缓解 500KB chunk warning + 让缓存复用率更高（首屏 vendor
          // 大概率不变，业务代码改动只 bust 业务 chunk）。用函数形式才能匹配
          // deep imports（react/jsx-runtime、react-dom/client 等）。
          manualChunks(id) {
            // 独立成块并由入口第一个导入：共享块先于入口正文执行，内联进入口就补晚了。
            if (id.includes('/src/boot/polyfills')) return 'polyfills'
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
