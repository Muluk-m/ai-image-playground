import { APP_MODE_PATHS, LEGACY_PROJECTS_PATH } from './appPaths'

/** 项目地址 `/p/<项目>` 的 Pages 写法。 */
export const PROJECT_ROUTE_PATTERN = '/p/:project'

/** 构建产物目录；`public/_headers` 给它下面的一切标一年 immutable。 */
const HASHED_ASSETS_PATH = '/assets'

/**
 * Cloudflare Pages 的 `_redirects`：只有业务路由回退到 SPA，缺失的资源必须保持 404。
 * 规则是精确匹配，`/assets` 页面不会吞掉 `/assets/*` 产物。
 *
 * 但 `/assets/` 本身也落在 `_headers` 的 `/assets/*` 里：在那里回退 SPA，页面 HTML 会被
 * 浏览器和边缘缓存一年，发版后资产页一直是旧版本。带斜杠的那个改成跳到不带斜杠的页面，
 * 跳转被缓存多久都无害。
 */
export function pagesRedirects(): string {
  const routes = [...Object.values(APP_MODE_PATHS), LEGACY_PROJECTS_PATH, PROJECT_ROUTE_PATTERN]
  const rules = routes.flatMap((route) => [
    `${route} / 200`,
    route === HASHED_ASSETS_PATH ? `${route}/ ${route} 301` : `${route}/ / 200`,
  ])
  return `# Generated from src/lib/appPaths.ts. Missing assets must remain 404.\n${rules.join('\n')}\n`
}

/** 构建时生成 `dist/_redirects`；形状是 Vite 的 Plugin，这里不 import vite。 */
export function pagesRedirectsPlugin() {
  return {
    name: 'pages-redirects',
    apply: 'build' as const,
    generateBundle(this: {
      emitFile(file: { type: 'asset'; fileName: string; source: string }): string
    }) {
      this.emitFile({ type: 'asset', fileName: '_redirects', source: pagesRedirects() })
    },
  }
}
