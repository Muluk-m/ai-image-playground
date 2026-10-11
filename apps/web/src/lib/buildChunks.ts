/**
 * 生产构建的第三方分片规则，以及「分片之间不许循环静态引用」的构建期守卫。
 *
 * 为什么要精确到 `node_modules/<包名>/`：
 * 早先用 `id.includes('/react/')` 判断 React，任何路径里带 `/react/` 目录的包都会被拉进
 * `react-vendor`——例如 `node_modules/@xyflow/react/`。xyflow 依赖 zustand，而 zustand 另有
 * 自己的分片，于是 `react-vendor` 与 `zustand` 两个分片互相 import；ES 模块循环下
 * `react-vendor` 还没求值完就被 `zustand` 调用，生产首页停在加载图标
 * （`TypeError: Cannot set properties of undefined (setting 'Activity')`）。
 */

// 兼容 Windows 路径分隔符；pnpm 的真实路径形如 `node_modules/.pnpm/<包>@<版本>/node_modules/<包名>/…`，
// 所以只认「紧跟在 node_modules/ 后面」的那一段。
const REACT_PACKAGES = /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/
// zustand 与它唯一的运行时依赖放在一起，让这个分片只向 react-vendor 单向引用。
// 项目里可能同时存在多个 zustand 大版本（如 @xyflow/react 带的 4.x），都落进同一个分片。
const ZUSTAND_PACKAGES = /[\\/]node_modules[\\/](?:zustand|use-sync-external-store)[\\/]/

/** `build.rollupOptions.output.manualChunks`：返回分片名，`undefined` 交给 Rollup 自行决定。 */
export function vendorChunk(id: string): string | undefined {
  // 独立成块并由入口第一个导入：共享块先于入口正文执行，内联进入口就补晚了。
  if (id.includes('/src/boot/polyfills')) return 'polyfills'
  if (REACT_PACKAGES.test(id)) return 'react-vendor'
  if (ZUSTAND_PACKAGES.test(id)) return 'zustand'
  return undefined
}

interface ChunkLike {
  type: string
  imports?: string[]
}

/** 在静态 import 图里找环；返回每个环（强连通分量）里的文件名。动态 import 不算：它们在运行时才求值。 */
export function findChunkCycles(bundle: Record<string, ChunkLike>): string[][] {
  const graph = new Map<string, string[]>()
  for (const [name, item] of Object.entries(bundle)) {
    if (item.type === 'chunk')
      graph.set(
        name,
        (item.imports ?? []).filter((d) => d in bundle),
      )
  }
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []
  const visit = (v: string) => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number))
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string | undefined
      do {
        w = stack.pop() as string
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      if (component.length > 1 || graph.get(v)?.includes(v)) cycles.push(component.sort())
    }
  }
  for (const v of graph.keys()) if (!index.has(v)) visit(v)
  return cycles
}

/**
 * 分片出现静态循环引用时直接让构建失败。
 * 这类问题只在生产产物里出现（dev 和单测都是原始模块图），之前要等部署后的浏览器冒烟才发现。
 */
export function chunkCycleGuardPlugin() {
  return {
    name: 'chunk-cycle-guard',
    apply: 'build' as const,
    generateBundle(
      this: { error(message: string): never },
      _options: unknown,
      bundle: Record<string, ChunkLike>,
    ) {
      const cycles = findChunkCycles(bundle)
      if (cycles.length === 0) return
      const detail = cycles.map((cycle) => `  ${cycle.join(' <-> ')}`).join('\n')
      this.error(
        `Static import cycle between output chunks (breaks module evaluation order in production):\n${detail}\n` +
          'Check build.rollupOptions.output.manualChunks in vite.config.ts (src/lib/buildChunks.ts).',
      )
    },
  }
}
