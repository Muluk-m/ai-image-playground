import type { IndexHtmlTransformContext } from 'vite'

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>

/** 工作台本体：AuthGate 登录态确定后才 `import('../App')`，见 auth/AuthGate.tsx。 */
const APP_MODULE = /\/src\/App\.tsx$/

/**
 * 启动链里登录检查和工作台主分片原本是串的：入口 → 运行时配置 → 能力/会话 → 才开始下 App 那一大片。
 * 在 HTML 里给 App 的静态依赖图挂上 modulepreload，下载和编译就和登录检查并行；只预取不执行，
 * App 和 store 仍在 AuthGate 切好存储分区之后才求值。入口本身的静态依赖 Vite 已经挂过，这里跳过。
 * modulepreload 失败不算启动失败（startup guard 只认 stylesheet 和 module script），
 * 真正 import 时 Vite 会照常再取一次。
 */
export function appPreloadLinks(bundle: Bundle | undefined, entry: string | undefined): string[] {
  if (!bundle || !entry) return []
  const chunk = (fileName: string) => {
    const output = bundle[fileName]
    return output?.type === 'chunk' ? output : undefined
  }
  const staticGraph = (root: string, into = new Set<string>()) => {
    const pending = [root]
    while (pending.length) {
      const fileName = pending.pop()!
      if (into.has(fileName)) continue
      const output = chunk(fileName)
      if (!output) continue
      into.add(fileName)
      pending.push(...output.imports)
    }
    return into
  }
  // transformIndexHtml 拿到的分片 facadeModuleId 是空的，只能按分片里的模块认。
  const isApp = (output: ReturnType<typeof chunk>) =>
    !!output?.isDynamicEntry && output.moduleIds.some((id) => APP_MODULE.test(id))
  const eager = staticGraph(entry)
  // 从入口沿动态 import 找到 App 分片；途经的分片（AuthGate 等）本来就会在 App 之前加载，一起预取。
  const path = new Map<string, string | undefined>([[entry, undefined]])
  const queue = [entry]
  let app: string | undefined
  while (queue.length && !app) {
    const fileName = queue.shift()!
    const output = chunk(fileName)
    if (!output) continue
    for (const next of [...output.imports, ...output.dynamicImports]) {
      if (path.has(next)) continue
      path.set(next, fileName)
      if (isApp(chunk(next))) {
        app = next
        break
      }
      queue.push(next)
    }
  }
  if (!app) return []
  const roots: string[] = []
  for (let at: string | undefined = app; at && at !== entry; at = path.get(at)) roots.unshift(at)
  const scripts = new Set<string>()
  for (const root of roots) staticGraph(root, scripts)
  const links: string[] = []
  const styles = new Set<string>()
  for (const fileName of scripts) {
    if (eager.has(fileName)) continue
    links.push(`<link rel="modulepreload" crossorigin href="/${fileName}">`)
    for (const css of chunk(fileName)?.viteMetadata?.importedCss ?? []) styles.add(css)
  }
  // Vite 的动态 import 会自己插 stylesheet；这里只提前下载，crossorigin 与它插的 link 一致才能复用缓存。
  for (const css of styles) links.push(`<link rel="preload" as="style" crossorigin href="/${css}">`)
  return links
}

export function appPreloadPlugin() {
  return {
    name: 'app-preload',
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string, context?: IndexHtmlTransformContext) {
        const links = appPreloadLinks(context?.bundle, context?.chunk?.fileName)
        if (!links.length) return
        return html.replace('</head>', `${links.join('')}</head>`)
      },
    },
  }
}
