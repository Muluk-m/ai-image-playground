import react from '@vitejs/plugin-react'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { vitestGuard } from '../../scripts/test-guard'
import { startupGuardPlugin } from './src/boot/vitePlugin'
import { chunkCycleGuardPlugin, vendorChunk } from './src/lib/buildChunks'
import { pagesRedirectsPlugin } from './src/lib/pagesRedirects'
import { optionalFontsPlugin } from './src/styles/fontPlugin'
import { themeBootPlugin } from './src/theme/vitePlugin'

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string
}

/** Production deploys set APP_RELEASE from the git tag. Local builds use MAJOR.MINOR.0 in the root package.json. */
function displayedVersion(): string {
  const fromEnv = process.env.APP_RELEASE?.trim()
  if (fromEnv && /^\d+\.\d+\.\d+$/.test(fromEnv)) return fromEnv
  return rootPkg.version
}

/** 最低支持的浏览器内核。Chrome 80 覆盖仍在使用的国产浏览器旧内核；Safari 14 覆盖 iOS 14。 */
const BROWSER_TARGET = ['es2020', 'chrome80', 'edge80', 'firefox78', 'safari14']

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

export default defineConfig(() => {
  return {
    plugins: [
      optionalFontsPlugin(),
      startupGuardPlugin(),
      react(),
      themeBootPlugin(),
      pagesRedirectsPlugin(),
      injectSwBuildVersion(),
      chunkCycleGuardPlugin(),
    ],
    base: '/',
    define: {
      __APP_VERSION__: JSON.stringify(displayedVersion()),
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
    },
    // jSquash 用 `new URL('*.wasm', import.meta.url)` 找自己的 wasm；预打包会把路径改坏。
    optimizeDeps: { exclude: ['@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng'] },
    worker: { format: 'es' as const },
    test: {
      ...vitestGuard('apps/web'),
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
        },
        output: {
          // 拆出第三方依赖，缓解 500KB chunk warning + 让缓存复用率更高（首屏 vendor
          // 大概率不变，业务代码改动只 bust 业务 chunk）。用函数形式才能匹配
          // deep imports（react/jsx-runtime、react-dom/client 等）。规则与循环守卫见 src/lib/buildChunks.ts。
          manualChunks: vendorChunk,
        },
      },
    },
  }
})
