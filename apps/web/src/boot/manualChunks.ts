/**
 * 拆出第三方依赖，缓解 500KB chunk warning + 让缓存复用率更高（首屏 vendor 大概率不变，
 * 业务代码改动只 bust 业务 chunk）。用函数形式才能匹配 deep imports（react/jsx-runtime、
 * react-dom/client 等）。
 */
export function manualChunks(id: string): string | undefined {
  // 独立成块并由入口第一个导入：共享块先于入口正文执行，内联进入口就补晚了。
  if (id.includes('/src/boot/polyfills')) return 'polyfills'
  if (!id.includes('node_modules')) return undefined
  // 按包根匹配：`@xyflow/react/` 这类路径也含 `/react/`，被并进来会和 zustand 块互相引用，
  // 首屏在 React 初始化前就调用它，整站起不来（#1167）。
  if (
    id.includes('/node_modules/react/') ||
    id.includes('/node_modules/react-dom/') ||
    id.includes('/node_modules/scheduler/')
  ) {
    return 'react-vendor'
  }
  if (id.includes('/zustand/')) return 'zustand'
  return undefined
}
