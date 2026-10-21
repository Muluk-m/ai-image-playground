/** 构建产物目录；`public/_headers` 给它下面的一切标一年 immutable。 */
const HASHED_ASSETS_PATH = '/assets'

/**
 * 从 TanStack Router 生成的 `routeTree.gen.ts` 里取出全部完整路径。
 * 私有覆盖层的路由在生成前已复制进 `src/routes`，所以这里同样包含它们。
 */
export function adminRoutePaths(routeTreeSource: string): string[] {
  const body = /export interface FileRoutesByFullPath \{([^}]*)\}/.exec(routeTreeSource)?.[1]
  if (body === undefined) throw new Error('routeTree.gen.ts 里没有 FileRoutesByFullPath')
  const paths = [...body.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1])
  if (!paths.length) throw new Error('routeTree.gen.ts 里没有任何路由')
  return paths
}

/** TanStack 路径（`/users/$userId`、`/users/`）转成 Pages 的写法（`/users/:userId`、`/users`）。 */
function toPagesPattern(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path
  return trimmed
    .split('/')
    .map((segment) => {
      if (segment === '$' || segment === '*') throw new Error(`Pages 规则不支持通配路由：${path}`)
      return segment.startsWith('$') ? `:${segment.slice(1)}` : segment
    })
    .join('/')
}

/**
 * Cloudflare Pages 的 `_redirects`：只有业务路由回退到 SPA，缺失的资源必须保持 404。
 *
 * 不能写 `/* /index.html 200`：那样缺失的 `/assets/*.js` 也会拿到 200 的首页 HTML，
 * 再被 `_headers` 标成一年 immutable。目标写 `/` 而不是 `/index.html`，因为 Pages 会把
 * 显式的 `.html` 目标规范化成跳转，即使在 200 改写里也一样。
 */
export function pagesRedirects(paths: string[]): string {
  const patterns = [...new Set(paths.map(toPagesPattern))].filter((pattern) => pattern !== '/')
  for (const pattern of patterns) {
    if (pattern === HASHED_ASSETS_PATH || pattern.startsWith(`${HASHED_ASSETS_PATH}/`))
      throw new Error(`路由不能落在 ${HASHED_ASSETS_PATH} 下：${pattern}`)
  }
  // Pages 要求静态规则写在动态规则（带占位符）前面，否则 `/a/b` 可能被 `/a/:id` 先吃掉。
  const ordered = [
    ...patterns.filter((pattern) => !pattern.includes(':')),
    ...patterns.filter((pattern) => pattern.includes(':')),
  ]
  const rules = ordered.flatMap((pattern) => [`${pattern} / 200`, `${pattern}/ / 200`])
  return `# Generated from src/routeTree.gen.ts. Missing assets must remain 404.\n${rules.join('\n')}\n`
}

/** 构建时生成 `dist/_redirects`；形状是 Vite 的 Plugin，这里不 import vite。 */
export function pagesRedirectsPlugin(readRouteTree: () => string) {
  return {
    name: 'pages-redirects',
    apply: 'build' as const,
    generateBundle(this: {
      emitFile(file: { type: 'asset'; fileName: string; source: string }): string
    }) {
      this.emitFile({
        type: 'asset',
        fileName: '_redirects',
        source: pagesRedirects(adminRoutePaths(readRouteTree())),
      })
    },
  }
}
