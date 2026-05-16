## Why

admin server（Plan A）已经完整：4 个路由、HMAC cookie 鉴权、速率限制、聚合查询、图片反代、launchd plist 都在 `apps/admin/server/` 跑通了。但是**没有前端**——目前只能 curl 验证 API。本提案落地 Plan A 文档末尾"下一步（Plan B）"列出的工作：脚手架前端、登录/设备列表/详情 UI、admin server 接静态托管、`deploy:local` 加 admin build。

设计 spec 见 `docs/superpowers/specs/2026-05-15-admin-dashboard-design.md`（详细），本提案在其基础上**收紧 8 个未拍板的决策**（详见 design.md）后落地，不再回头讨论。

## What Changes

- 新建 `apps/admin/src/`：Vite + React 19 + TS 5.8 + Tailwind v3 + TanStack Router (file-based) + TanStack Query + shadcn (Radix + lucide) 脚手架，与 `apps/web/` 对齐 v3 不引入 Tailwind v4 试点。
- 实现 5 个路由：`/login`、`/_authed/devices`、`/_authed/devices/$deviceId`、`/_authed/tasks/$taskId`（deeplink redirect）、`__root` 顶栏 layout。
- 实现 4 个数据 hook：`useMe`、`useDevices(range, sort)`、`useDeviceDetail(deviceId, range)`、`useTask(taskId)`，封装在 `src/lib/queries.ts`。
- 全局 fetch wrapper（`src/lib/api-client.ts`）：401 → `router.navigate('/login')` + `queryClient.clear()`。
- TaskDetailView 组件抽屉 + 全屏 lightbox 复用：search params `?task=<id>&fullscreen=1` 控开关；输出图 / 参考图（input-image）走反代端点。
- 列表页不渲染缩略图（按 design.md 默认），详情页才渲染。
- admin server 端 `getTask` 返 `device_id`（VIRTUAL 列 raw sql 拼），供前端 `/tasks/$taskId` deeplink redirect 用。
- admin server `index.ts` 接 `serveStatic` + `serveSpaFallback`（**从 BFF 复制 60 行**，不抽 `packages/server-utils/`）。
- 仓库根 `package.json` 的 `deploy:local` 加 `pnpm --filter @image-playground/admin build` + `launchctl kickstart -k gui/$(id -u)/qlj.image-playground.admin`，顺序在 BFF 之后、cloudflared 之前。
- 前端测试（Vitest + jsdom + RTL）只覆盖：`api-client` 401 拦截、`login.tsx` 表单成功/失败 navigate、URL search params parse helper。其余视图层不做 RTL。

## Capabilities

### New Capabilities

- `admin-ui`: admin 前端工程形态、路由树、数据获取约定、URL 状态约定（range/sort/task/fullscreen）、TaskDetailView 抽屉+lightbox 复用规则、生产同源部署形态。
- `admin-static-serve`: admin server 静态托管（serveStatic + SPA fallback）的实现来源与策略（gzip / cache-control / index.html no-store）。

### Modified Capabilities

- `admin-api`: `GET /api/tasks/:id` 返回新增 `device_id` 字段（VIRTUAL 列 raw sql 抽取），供前端 deeplink redirect。

## Impact

- **代码**：新增 `apps/admin/src/`（约 30 个文件）、`apps/admin/index.html`、`apps/admin/vite.config.ts`、`apps/admin/tailwind.config.ts`、`apps/admin/postcss.config.js`、`apps/admin/tsconfig.json` 更新、`apps/admin/components.json`；修改 `apps/admin/server/index.ts`（接静态托管）、`apps/admin/server/app.ts`、`apps/admin/server/routes/tasks.ts` 或 `lib/queries.ts`（getTask 返 device_id）；修改根 `package.json` 的 `deploy:local`。
- **依赖**：`apps/admin/package.json` 加：`react` / `react-dom` / `@tanstack/react-router` / `@tanstack/react-query` / `@tanstack/router-vite-plugin` / `@radix-ui/*`（按 shadcn 拉取自动管理）/ `lucide-react` / `clsx` / `tailwind-merge` / `class-variance-authority` / `tailwindcss@3` / `postcss` / `autoprefixer` / `vite` / `@vitejs/plugin-react` / `vitest` / `@testing-library/react` / `jsdom`。
- **构建**：admin 新增 `scripts.build = "tsc -b && vite build"`、`scripts.dev`、`scripts.test`；turbo.json 默认会捕获到。
- **部署**：launchd plist 已存在（commit 7fbb56b），无需新增；`deploy:local` 加两行命令；cloudflared ingress 在 mac mini 本地配（仓库不动，跟 7fbb56b 风格一致）。
- **数据**：无 schema 变化；admin SQLite 仍 readonly + query_only=ON。
- **文档**：`CLAUDE.md` 顶部「项目概况」加 `apps/admin/` 一行；`apps/admin/` 不新增 README，commit message 自带说明即可。
- **不变**：admin server 鉴权、限速、queries 实现；BFF 任何代码；apps/web 任何代码；packages/db 与 packages/shared。
