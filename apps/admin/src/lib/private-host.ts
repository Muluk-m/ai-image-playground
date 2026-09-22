/**
 * 管理后台暴露给私有 overlay 的宿主面。规则同 `apps/web/src/lib/privateHost.ts`：
 * overlay 只许从这里与 `private-overlay.tsx` 取公开树的东西；改这里 = 改对 overlay 的承诺，先扩后缩。
 *
 * 这份只放不带 React 树的 lib 面。UI 组件在 `private-host-ui.ts`：那一桶会把整个 shadcn 树和
 * `@/` 别名一起拖进来，overlay 的 bun 测试只要 apiClient 时不该为此付出解析 `@/lib/utils` 的代价。
 */

export { ApiError, apiClient } from './api-client'
