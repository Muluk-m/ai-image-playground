## 0. Server 端补 device_id（前端 deeplink 前置）

- [x] 0.1 在 `apps/admin/server/lib/queries.ts` 的 `getTask()` 里加 raw sql `SELECT device_id FROM tasks WHERE id = ?`，把结果合并进 `TaskDetail` 返回（新增字段 `device_id: string | null`）
- [x] 0.2 更新 `apps/admin/server/lib/queries.ts` 的 `TaskDetail` 类型导出
- [x] 0.3 跑 `pnpm --filter @image-playground/admin test` 确认 server tests 不挂；不挂就说明 task 详情既有覆盖（如有 mock 不齐再调）—— pre-existing `反代 BFF binary` 测试在 main 上也挂，与本次改动无关；新增 device_id 断言通过
- [x] 0.4 atomic commit: `feat(admin): /api/tasks/:id 返回 device_id 字段`

## 1. 前端工程脚手架

- [x] 1.1 `apps/admin/package.json` 加 dependencies：`react@^19.1.0` / `react-dom@^19.1.0` / `@tanstack/react-router@^1` / `@tanstack/react-query@^5` / `clsx` / `tailwind-merge` / `class-variance-authority` / `lucide-react` / `@radix-ui/react-slot` (shadcn 必备) — 额外加 @radix-ui/{dialog,progress,tooltip} 配合 shadcn 8 组件
- [x] 1.2 `apps/admin/package.json` 加 devDependencies：`vite@^6` / `@vitejs/plugin-react@^4` / `@tanstack/router-vite-plugin@^1` / `typescript@^5.8` / `tailwindcss@^3.4.17` / `postcss` / `autoprefixer` / `vitest@^4` / `@testing-library/react` / `@testing-library/dom` / `jsdom` / `@types/react` / `@types/react-dom` — 额外加 @testing-library/{jest-dom,user-event}
- [x] 1.3 `apps/admin/package.json` scripts：`dev` = `vite`，`build` = `tsc -b && vite build`，`typecheck` = `tsc -b`，`test` = `vitest run`；保留现有 `dev:server` / `start`（server）—— test 合成 `vitest run && bun test server` 双跑；额外暴露 test:server / test:client
- [x] 1.4 `pnpm install` 拉依赖（+175 包）
- [x] 1.5 创建 `apps/admin/index.html`（标题 `image-playground admin` + `<div id="root"></div>` + `<script src="/src/main.tsx" type="module">`）
- [x] 1.6 创建 `apps/admin/vite.config.ts`：`TanStackRouterVite() + react()` plugin，alias `@ → ./src`，dev `server.proxy['/api'] = 'http://localhost:37378'` —— 同时配 vitest jsdom + setupFiles
- [x] 1.7 创建 `apps/admin/tsconfig.json` 更新：拆 solution（tsconfig.json）+ tsconfig.app.json（DOM + react-jsx + `@/*` paths + composite）+ tsconfig.server.json（bun types + composite），`typecheck = tsc -b` 跑双 project
- [x] 1.8 创建 `apps/admin/tailwind.config.js`（content + zinc 色板 + 字体 + shadcn HSL token）：抄 web 风格 + 加 shadcn cssVariables 所需 token
- [x] 1.9 创建 `apps/admin/postcss.config.js`（tailwindcss + autoprefixer）
- [x] 1.10 创建 `apps/admin/components.json`（shadcn config，style: new-york，base: zinc，tailwind v3，aliases utils=@/lib/utils, components=@/components）
- [x] 1.11 atomic commit: `feat(admin): 前端脚手架（Vite + React 19 + TS + Tailwind v3 + TanStack）`

## 2. shadcn 组件与基础

- [x] 2.1 创建 `apps/admin/src/lib/utils.ts` 导出 `cn = (...inputs) => twMerge(clsx(inputs))`
- [x] 2.2 拉 8 个 shadcn 组件到 `apps/admin/src/components/ui/`：button / input / table / sheet / dialog / badge / progress / tooltip —— 手 copy（CLI 在 monorepo 配 alias 麻烦），new-york / zinc 风格；额外装 tailwindcss-animate 给动画类
- [x] 2.3 创建 `apps/admin/src/index.css`：`@tailwind base; @tailwind components; @tailwind utilities;` + body 字体 fallback —— 含 shadcn HSL token 浅/深色
- [x] 2.4 在 `index.html` 引用 `index.css`（通过 main.tsx import 即可，下个 section 落地 main.tsx）
- [x] 2.5 atomic commit: `feat(admin): shadcn UI primitives（8 个组件）`

## 3. Router + Query 装配

- [x] 3.1 创建 `apps/admin/src/main.tsx`：构造 `QueryClient`（staleTime: Infinity, gcTime: 5min, retry: false）+ `createRouter({ context: { queryClient } })` + `RouterProvider` + `QueryClientProvider`，挂到 `#root`
- [x] 3.2 创建 `apps/admin/src/routes/__root.tsx`：`createRootRouteWithContext<{ queryClient: QueryClient }>()`，渲染 `<Outlet />`，404 fallback 简单文案 —— 顶栏延到 Section 6
- [x] 3.3 创建 `apps/admin/src/routes/index.tsx`：`beforeLoad: () => throw redirect({ to: '/devices' })`
- [x] 3.4 让 `@tanstack/router-vite-plugin` 生成 `src/routeTree.gen.ts`（vite build 触发，入 git）；同时落 login / _authed / _authed.devices.{index,$deviceId} / _authed.tasks.$taskId 五个 placeholder stub 让 routeTree 一次性完整
- [x] 3.5 atomic commit: `feat(admin): TanStack Router + Query 装配`

## 4. fetch 封装 + 401 拦截

- [x] 4.1 创建 `apps/admin/src/lib/api-client.ts`：apiClient.get/.post + setApiClientRefs + ApiError / UnauthorizedError 类型
- [x] 4.2 main.tsx 启动后 `setApiClientRefs({ router, queryClient })`
- [x] 4.3 创建 `apps/admin/src/__tests__/lib/api-client.test.ts`：4 个场景全过（200/401/500/post body）
- [x] 4.4 atomic commit: `feat(admin): api-client 封装 + 401 拦截`

## 5. URL search params 校验

- [x] 5.1 创建 `apps/admin/src/lib/search-params.ts`：6 个 narrow helper + 2 组合 parser；额外加 imgIdx / imgKind（lightbox 用）
- [x] 5.2 创建 `apps/admin/src/__tests__/lib/search-params.test.ts`：16 个 case 全过
- [x] 5.3 atomic commit: `feat(admin): URL search params 校验 helper`

## 6. 顶栏 + 鉴权守卫

- [x] 6.1 创建 `apps/admin/src/components/TopBar.tsx`：logo / range segmented / refresh / logout
- [x] 6.2 创建 `apps/admin/src/routes/_authed.tsx`：beforeLoad ensureQueryData ['me']，失败 redirect /login + 带 redirect=<原路径>
- [x] 6.3 在 `__root.tsx` 渲染 `<TopBar />`（顶部），下方 `<Outlet />`，套 `<TooltipProvider />`
- [x] 6.4 atomic commit: `feat(admin): 顶栏 + _authed layout 守卫`

## 7. 登录页

- [x] 7.1 创建 `apps/admin/src/routes/login.tsx` + 拆 `<LoginForm />` 组件；submit 后 navigate `/devices` 或 search 中的 redirect
- [x] 7.2 已登录访问 `/login` → `beforeLoad` ensureQueryData /api/me，200 → redirect `/devices`
- [x] 7.3 创建 `apps/admin/src/__tests__/components/LoginForm.test.tsx`：4 个 case 全过（成功 / 401 / 429 / 空密码 disabled）；setup.ts 加 RTL cleanup
- [x] 7.4 atomic commit: `feat(admin): 登录页 + 测试`

## 8. 设备列表页

- [x] 8.1 创建 `apps/admin/src/lib/types.ts`：复用 server 类型 + DAILY_QUOTA_LIMIT
- [x] 8.2 创建 `apps/admin/src/lib/queries.ts`：useDevices / useDeviceDetail / useTask
- [x] 8.3 创建 `apps/admin/src/components/ShortId.tsx`
- [x] 8.4 创建 `apps/admin/src/components/ModelChips.tsx`
- [x] 8.5 创建 `apps/admin/src/components/FuzzyTime.tsx`
- [x] 8.6 创建 `apps/admin/src/components/DeviceTable.tsx`
- [x] 8.7 创建 `apps/admin/src/routes/_authed.devices.index.tsx`：validateSearch + loading/error/empty/truncated 黄条 + DeviceTable
- [x] 8.8 列表行用 `<Link to="/devices/$deviceId" params={...}>` 直接跳详情（保留当前 range 由 TanStack search 默认合并行为完成）
- [x] 8.9 atomic commit: `feat(admin): 设备列表页`

## 9. 设备详情页

- [x] 9.1 创建 `apps/admin/src/components/DeviceMetaCard.tsx`
- [x] 9.2 创建 `apps/admin/src/components/StatusBadge.tsx`：6 种 status
- [x] 9.3 创建 `apps/admin/src/components/TaskTable.tsx`：列按 design spec 第 429 行（**不渲染缩略图**，n 显数字；行点击打开抽屉）
- [x] 9.4 创建 `apps/admin/src/routes/_authed.devices.$deviceId.tsx`：装配 DeviceMetaCard + TaskTable + TaskDetailSheet stub
- [x] 9.5 atomic commit: `feat(admin): 设备详情页`

## 10. 任务详情视图 + Lightbox

- [x] 10.1 创建 `apps/admin/src/components/TaskDetailView.tsx`：含参考图区按 provider 推断
- [x] 10.2 创建 `apps/admin/src/components/TaskDetailSheet.tsx`
- [x] 10.3 创建 `apps/admin/src/components/LightboxDialog.tsx`（含键盘 ArrowLeft/Right 翻页）
- [x] 10.4 atomic commit: `feat(admin): TaskDetailView + 抽屉 + 全屏 lightbox`

## 11. 任务 deeplink redirect 路由

- [x] 11.1 创建 `apps/admin/src/routes/_authed.tasks.$taskId.tsx`：beforeLoad redirect 到 /devices/$deviceId?task=…，device_id null 走错误页
- [x] 11.2 atomic commit: `feat(admin): /tasks/:id deeplink redirect`

## 12. admin server 接静态托管

- [x] 12.1 创建 `apps/admin/server/static.ts`：复制 + 剔除 BFF 专属分支 + path-traversal 防御
- [x] 12.2 修改 `apps/admin/server/app.ts`：onRequest 试静态 + onError 走 SPA fallback
- [x] 12.3 `config.staticDir = env('ADMIN_DIST_DIR', '')`：空时整条 no-op（dev mode）
- [x] 12.4 server tests 覆盖 6 个静态场景 + 既有 41 个 API 测试不回归
- [x] 12.5 atomic commit: `feat(admin): server 接 dist 静态托管 + SPA fallback`

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
