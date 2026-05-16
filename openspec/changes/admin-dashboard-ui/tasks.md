## 0. Server 端补 device_id（前端 deeplink 前置）

- [x] 0.1 在 `apps/admin/server/lib/queries.ts` 的 `getTask()` 里加 raw sql `SELECT device_id FROM tasks WHERE id = ?`，把结果合并进 `TaskDetail` 返回（新增字段 `device_id: string | null`）
- [x] 0.2 更新 `apps/admin/server/lib/queries.ts` 的 `TaskDetail` 类型导出
- [x] 0.3 跑 `pnpm --filter @image-playground/admin test` 确认 server tests 不挂；不挂就说明 task 详情既有覆盖（如有 mock 不齐再调）—— pre-existing `反代 BFF binary` 测试在 main 上也挂，与本次改动无关；新增 device_id 断言通过
- [ ] 0.4 atomic commit: `feat(admin): /api/tasks/:id 返回 device_id 字段`

## 1. 前端工程脚手架

- [ ] 1.1 `apps/admin/package.json` 加 dependencies：`react@^19.1.0` / `react-dom@^19.1.0` / `@tanstack/react-router@^1` / `@tanstack/react-query@^5` / `clsx` / `tailwind-merge` / `class-variance-authority` / `lucide-react` / `@radix-ui/react-slot` (shadcn 必备)
- [ ] 1.2 `apps/admin/package.json` 加 devDependencies：`vite@^6` / `@vitejs/plugin-react@^4` / `@tanstack/router-vite-plugin@^1` / `typescript@^5.8` / `tailwindcss@^3.4.17` / `postcss` / `autoprefixer` / `vitest@^4` / `@testing-library/react` / `@testing-library/dom` / `jsdom` / `@types/react` / `@types/react-dom`
- [ ] 1.3 `apps/admin/package.json` scripts：`dev` = `vite`，`build` = `tsc -b && vite build`，`typecheck` = `tsc -b`，`test` = `vitest run`；保留现有 `dev:server` / `start`（server）
- [ ] 1.4 `pnpm install` 拉依赖
- [ ] 1.5 创建 `apps/admin/index.html`（标题 `image-playground admin` + `<div id="root"></div>` + `<script src="/src/main.tsx" type="module">`）
- [ ] 1.6 创建 `apps/admin/vite.config.ts`：`TanStackRouterVite() + react()` plugin，alias `@ → ./src`，dev `server.proxy['/api'] = 'http://localhost:37378'`
- [ ] 1.7 创建 `apps/admin/tsconfig.json` 更新：`compilerOptions.paths` 加 `"@/*": ["./src/*"]`，include `["src", "vite.config.ts"]`
- [ ] 1.8 创建 `apps/admin/tailwind.config.ts`（content + zinc 色板 + 字体）：直接抄 `apps/web/tailwind.config.ts`，去掉 web 专属内容
- [ ] 1.9 创建 `apps/admin/postcss.config.js`（tailwindcss + autoprefixer）
- [ ] 1.10 创建 `apps/admin/components.json`（shadcn config，style: new-york，base: zinc，tailwind v3，aliases utils=@/lib/utils, components=@/components）
- [ ] 1.11 atomic commit: `feat(admin): 前端脚手架（Vite + React 19 + TS + Tailwind v3 + TanStack）`

## 2. shadcn 组件与基础

- [ ] 2.1 创建 `apps/admin/src/lib/utils.ts` 导出 `cn = (...inputs) => twMerge(clsx(inputs))`
- [ ] 2.2 拉 8 个 shadcn 组件到 `apps/admin/src/components/ui/`：button / input / table / sheet / dialog / badge / progress / tooltip（用 `npx shadcn@latest add button input table sheet dialog badge progress tooltip` 或手 copy；选 new-york / zinc）
- [ ] 2.3 创建 `apps/admin/src/index.css`：`@tailwind base; @tailwind components; @tailwind utilities;` + body 字体 fallback
- [ ] 2.4 在 `index.html` 引用 `index.css`（通过 main.tsx import 即可）
- [ ] 2.5 atomic commit: `feat(admin): shadcn UI primitives（8 个组件）`

## 3. Router + Query 装配

- [ ] 3.1 创建 `apps/admin/src/main.tsx`：构造 `QueryClient`（staleTime: Infinity, gcTime: 5min, retry: false）+ `createRouter({ context: { queryClient } })` + `RouterProvider` + `QueryClientProvider`，挂到 `#root`
- [ ] 3.2 创建 `apps/admin/src/routes/__root.tsx`：`createRootRouteWithContext<{ queryClient: QueryClient }>()`，渲染顶栏 + `<Outlet />`，404 fallback 简单文案
- [ ] 3.3 创建 `apps/admin/src/routes/index.tsx`：`beforeLoad: () => throw redirect({ to: '/devices' })`
- [ ] 3.4 让 `@tanstack/router-vite-plugin` 生成 `src/routeTree.gen.ts`（vite dev 启一次自动出文件；把它入 git）
- [ ] 3.5 atomic commit: `feat(admin): TanStack Router + Query 装配`

## 4. fetch 封装 + 401 拦截

- [ ] 4.1 创建 `apps/admin/src/lib/api-client.ts`：
  - 内部维护 `let routerRef` / `let queryClientRef`（由 main.tsx 启动后回填，避免循环依赖）
  - 导出 `apiClient.get(url) / .post(url, body)`，credentials: include
  - 200 → `await res.json()`
  - 401 → `queryClientRef.clear() + routerRef.navigate({ to: '/login' })`，throw redirect err
  - 4xx/5xx → throw `ApiError(status, body)`
- [ ] 4.2 main.tsx 启动后 `setApiClientRefs({ router, queryClient })`
- [ ] 4.3 创建 `apps/admin/src/__tests__/lib/api-client.test.ts`：mock fetch，覆盖 200 / 401 / 500 三种 + 401 时 router.navigate 与 queryClient.clear 都被调
- [ ] 4.4 atomic commit: `feat(admin): api-client 封装 + 401 拦截`

## 5. URL search params 校验

- [ ] 5.1 创建 `apps/admin/src/lib/search-params.ts`：
  - `parseRange(v): '1d'|'7d'|'30d'` 默认 `'7d'`
  - `parseSort(v): SortKey` 默认 `'last_seen'`
  - `parseTaskId(v): string | undefined`
  - `parseFullscreen(v): '1' | undefined`
- [ ] 5.2 创建 `apps/admin/src/__tests__/lib/search-params.test.ts`：覆盖合法值通过 / 非法值兜底默认 / undefined 通过
- [ ] 5.3 atomic commit: `feat(admin): URL search params 校验 helper`

## 6. 顶栏 + 鉴权守卫

- [ ] 6.1 创建 `apps/admin/src/components/TopBar.tsx`：
  - logo 文案点回 `/devices`
  - range segmented control（用 button 组组实现，无需新组件）—— `/devices` 与 `/devices/$deviceId` 都消费 `range`
  - refresh 按钮 → invalidateQueries `['devices']` / `['device']` / `['task']`
  - logout 按钮 → POST `/api/logout` → `queryClient.clear()` + `router.navigate('/login')`
- [ ] 6.2 创建 `apps/admin/src/routes/_authed.tsx`：layout route，`beforeLoad` ensureQueryData `['me']` 失败 redirect `/login`
- [ ] 6.3 在 `__root.tsx` 渲染 `<TopBar />`（顶部），下方 `<Outlet />`
- [ ] 6.4 atomic commit: `feat(admin): 顶栏 + _authed layout 守卫`

## 7. 登录页

- [ ] 7.1 创建 `apps/admin/src/routes/login.tsx`：单 password input + submit；提交 POST `/api/login`，成功 navigate `/devices`，错误显示 `error_code`（`invalid_password` → "密码错误"，`rate_limited` → "登录过于频繁，请稍后再试"）
- [ ] 7.2 已登录访问 `/login` → `beforeLoad` 探 `/api/me`，200 → redirect `/devices`
- [ ] 7.3 创建 `apps/admin/src/__tests__/routes/login.test.tsx`：jsdom + RTL，覆盖成功表单 → navigate / 401 → 错误文案 / 429 → 锁定文案
- [ ] 7.4 atomic commit: `feat(admin): 登录页 + 测试`

## 8. 设备列表页

- [ ] 8.1 创建 `apps/admin/src/lib/types.ts`：从 admin server `queries.ts` 复用 `DeviceRow` / `ListDevicesResult` / `TaskListItem` / `TaskDetail` 类型（手抄到 admin/src 而不是跨包 import server 代码，避免前端打包 server deps）
- [ ] 8.2 创建 `apps/admin/src/lib/queries.ts`：导出 `useDevices(range, sort)`、`useDeviceDetail(deviceId, range)`、`useTask(taskId)`，包 `useQuery`
- [ ] 8.3 创建 `apps/admin/src/components/ShortId.tsx`：8 字短码 + `Copy` 按钮 + Tooltip 全 id
- [ ] 8.4 创建 `apps/admin/src/components/ModelChips.tsx`：从 `models_csv` 切分，最多 3 个 chip + `+N more`（鼠标 hover 展开）
- [ ] 8.5 创建 `apps/admin/src/components/FuzzyTime.tsx`：相对时间 + hover ISO
- [ ] 8.6 创建 `apps/admin/src/components/DeviceTable.tsx`：shadcn `<Table>`，列按 design spec 第 408 行表格
- [ ] 8.7 创建 `apps/admin/src/routes/_authed.devices.index.tsx`：解析 search `{range, sort}` → useDevices → render `<DeviceTable />`；truncated 时顶部黄条 "仅显示前 500 条设备"
- [ ] 8.8 列表行点击 → `navigate({ to: '/devices/$deviceId', params: { deviceId }, search: prev => ({ range: prev.range ?? '7d' }) })`
- [ ] 8.9 atomic commit: `feat(admin): 设备列表页`

## 9. 设备详情页

- [ ] 9.1 创建 `apps/admin/src/components/DeviceMetaCard.tsx`：full UUID + copy / 今日 `X/50` Progress / 近 N 天累计 / 模型 chips
- [ ] 9.2 创建 `apps/admin/src/components/StatusBadge.tsx`：4 种状态 badge（succeeded / failed / running / queued）
- [ ] 9.3 创建 `apps/admin/src/components/TaskTable.tsx`：列按 design spec 第 429 行（图数列只显 `n=4` 占位文本，**不渲染缩略图**）；行点击 → `navigate({ search: prev => ({ ...prev, task: row.id }) })`
- [ ] 9.4 创建 `apps/admin/src/routes/_authed.devices.$deviceId.tsx`：解析 search `{range, task, fullscreen}` → useDeviceDetail → 渲染 `<DeviceMetaCard />` + `<TaskTable />` + `<TaskDetailSheet />`（task 存在时打开）
- [ ] 9.5 atomic commit: `feat(admin): 设备详情页`

## 10. 任务详情视图 + Lightbox

- [ ] 10.1 创建 `apps/admin/src/components/TaskDetailView.tsx`：
  - Request 区：provider / model / size / n / quality / prompt 全文
  - Result 区：status / duration / 输出图（按 `result_meta.images[].index` 渲染 `<img src="/api/tasks/:id/image?idx=N" />`，loading="lazy"）
  - 参考图区（图生图时）：渲染 `<img src="/api/tasks/:id/input-image?idx=N" onError={...} />`；404 / 422 → 灰条「参考图未存档」
  - 点图 → `navigate({ search: prev => ({ ...prev, fullscreen: '1', imgIdx: idx, imgKind: 'output'|'input' }) })`
- [ ] 10.2 创建 `apps/admin/src/components/TaskDetailSheet.tsx`：`<Sheet open={!!search.task}>` 包 `<TaskDetailView />`；close → `navigate({ search: prev => ({ ...prev, task: undefined, fullscreen: undefined }) })`
- [ ] 10.3 创建 `apps/admin/src/components/LightboxDialog.tsx`：`<Dialog open={search.fullscreen === '1'}>` 全屏图 + 上下两侧导航 + ESC 关闭
- [ ] 10.4 atomic commit: `feat(admin): TaskDetailView + 抽屉 + 全屏 lightbox`

## 11. 任务 deeplink redirect 路由

- [ ] 11.1 创建 `apps/admin/src/routes/_authed.tasks.$taskId.tsx`：`beforeLoad` ensureQueryData `['task', taskId]` → `throw redirect({ to: '/devices/$deviceId', params: { deviceId: task.device_id }, search: { range: '7d', task: taskId } })`；`task.device_id === null` → 渲染错误页 "任务无关联设备"
- [ ] 11.2 atomic commit: `feat(admin): /tasks/:id deeplink redirect`

## 12. admin server 接静态托管

- [ ] 12.1 创建 `apps/admin/server/static.ts`：从 `apps/bff/src/app.ts` 复制 `serveStatic` + `serveSpaFallback` + `cacheControlFor` + MIME 表 + gzip 探测；剔除 SW / hero-seed 等 BFF 专属分支；导出 `serveStatic({ root })` 与 `serveSpaFallback({ root })`
- [ ] 12.2 修改 `apps/admin/server/app.ts`：从 `static.ts` import；在 `app` 末尾（所有 API 路由之后）`.use(serveStatic({ root: resolveDistRoot() })).use(serveSpaFallback({ root: resolveDistRoot() }))`
- [ ] 12.3 `resolveDistRoot()`：优先 env `ADMIN_DIST_DIR`，回退 `path.join(process.cwd(), 'apps/admin/dist')`
- [ ] 12.4 跑 admin 的 server tests 确保静态托管不破坏现有 API（404 路径在 API 之后 fallback 到 index.html，但 `/api/*` 命中 404 仍走 API 404）—— 测试覆盖：未匹配 `/foo` GET → 200 + html，未匹配 `/api/missing` GET → 404 + JSON
- [ ] 12.5 atomic commit: `feat(admin): server 接 dist 静态托管 + SPA fallback`

## 13. deploy:local 改造

- [ ] 13.1 修改根 `package.json` 的 `deploy:local`：链 `pnpm --filter @image-playground/web build` && `pnpm --filter @image-playground/admin build` && bff kickstart && admin kickstart && cloudflared kickstart
- [ ] 13.2 确认 admin launchd plist（`apps/admin/deploy/qlj.image-playground.admin.plist`）的 EnvironmentVariables 已含 `ADMIN_DIST_DIR=/Users/qiqian/workspace/repos/qlj-image-playground/apps/admin/dist`；没有就加上（commit 7fbb56b 已部分落地，本任务确认补全）
- [ ] 13.3 atomic commit: `feat(admin): deploy:local 接 admin build + kickstart`

## 14. 三件套检查 + push

- [ ] 14.1 跑 `pnpm exec biome check --write .`
- [ ] 14.2 跑 `pnpm typecheck`（确保 admin / bff / web / shared / db 全过）
- [ ] 14.3 跑 `pnpm test`（admin server + admin client + bff + web 全过；admin client 三个测试文件齐全）
- [ ] 14.4 部署前先 `ssh macmini` 跑队列空闲检查（CLAUDE.md 部署规范）
- [ ] 14.5 `git push origin main` → 部署：`ssh macmini "cd /Users/qiqian/workspace/repos/qlj-image-playground && git pull --rebase --autostash origin main && pnpm install --prefer-offline && pnpm deploy:local"`（**本次新增 admin 前端依赖，必须先 install 再 deploy**——CLAUDE.md 部署规范的坑）
- [ ] 14.6 浏览器手测：访问 admin tunnel hostname → login → 设备列表 → 进设备详情 → 点 task 进抽屉 → 点图全屏 → 关闭 → 切 range → refresh → logout

## 后续提案（不在本次范围）

- 视图层 RTL 覆盖
- Tailwind v4 + ui-tokens 抽包
- packages/server-utils 抽包
- 列表页缩略图渲染
- OpenAI 图生图参考图存档
- 写操作（重置配额 / 封禁设备 / 删除 task）
