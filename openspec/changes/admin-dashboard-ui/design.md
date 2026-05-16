# Admin Dashboard UI — 实施设计

本设计基于 `docs/superpowers/specs/2026-05-15-admin-dashboard-design.md`（以下简称 "design spec"），仅记录**收紧的决策**和 **执行细节**。design spec 已经覆盖的内容（鉴权、查询、反代语义、UI 视图描述、风险）此处不复述。

## 收紧的 8 个决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | Tailwind 版本 | **v3** | 跟 C 端 `apps/web/` 齐头（v3.4.17），零 token 适配；v4 升级以后 web + admin 一起做 |
| 2 | `serveStatic` 来源 | **从 BFF 复制 60 行到 admin** | 不抽 `packages/server-utils/`，admin 没 SW / 没 hero-seed 资源，逻辑会比 BFF 简单；分叉风险低 |
| 3 | shadcn 组件 | **copy 8 个**：button / input / table / sheet / dialog / badge / progress / tooltip + 必要的 `utils.ts` | 通过 `npx shadcn add ...` 拉到 `src/components/ui/`；无 CLI 也可手 copy |
| 4 | 列表缩略图 | **不渲染** | design spec 默认；详情页才渲染；省成功 task 列表每行 n 次反代请求 |
| 5 | CORS | **保留 cors plugin**，dev 用 Vite proxy `/api → :37378` | 生产同源不依赖 cors；保留 plugin 不删，避免误改其他场景。dev 走 proxy 不带 cors |
| 6 | 前端测试范围 | **3 个**：`api-client.test.ts`（401 拦截 + clear cache）、`login.test.tsx`（表单成功/失败/锁定 navigate）、`search-params.test.ts`（URL parse helper round-trip） | 自用工具，覆盖核心保命用；视图层 RTL 暂不做 |
| 7 | task deeplink | **server 端 `getTask` 返 `device_id`**（raw sql 抽 VIRTUAL 列），前端 `/tasks/$taskId` beforeLoad 一次 fetch → `router.navigate({ to: '/devices/$deviceId', search: { task: taskId, ... } })` | 比"加新接口 `GET /api/tasks/:id/device`" 更省；getTask 已经 SELECT *，加一个 raw sql column 成本极低 |
| 8 | deploy / tunnel | `deploy:local` 加 admin build + kickstart；cloudflared ingress 配在 mac mini 本地（不入仓库） | 跟 commit 7fbb56b 已有的"plist 入仓 / cloudflared 不入仓"风格一致 |

## 工程脚手架

```
apps/admin/
├── package.json              # 加 react/vite/tanstack/tailwind 等
├── tsconfig.json             # 加 src/ 引用
├── vite.config.ts            # @vitejs/plugin-react + @tanstack/router-vite-plugin + proxy /api → :37378
├── tailwind.config.ts        # content: ./index.html, ./src/**/*.{ts,tsx}; 复制 web 的 zinc 色板 token + 三字体族（system 简化）
├── postcss.config.js         # tailwindcss + autoprefixer
├── components.json           # shadcn config（new-york / zinc / tailwind v3 + css var）
├── index.html
├── src/
│   ├── main.tsx              # createRouter + QueryClientProvider + RouterProvider
│   ├── index.css             # @tailwind base/components/utilities + body 字体
│   ├── routeTree.gen.ts      # tanstack router 生成（入 git，跟官方推荐一致）
│   ├── routes/
│   │   ├── __root.tsx        # 顶栏 + Outlet（404 fallback）
│   │   ├── index.tsx         # beforeLoad → redirect /devices
│   │   ├── login.tsx
│   │   ├── _authed.tsx       # layout route, beforeLoad fetch /api/me, 401 → redirect /login
│   │   ├── _authed.devices.index.tsx
│   │   ├── _authed.devices.$deviceId.tsx
│   │   └── _authed.tasks.$taskId.tsx   # beforeLoad fetch /api/tasks/:id, redirect /devices/$deviceId?task=...
│   ├── components/
│   │   ├── ui/               # shadcn copy（8 个组件 + utils.ts）
│   │   ├── TopBar.tsx
│   │   ├── DeviceTable.tsx
│   │   ├── DeviceMetaCard.tsx
│   │   ├── TaskTable.tsx
│   │   ├── TaskDetailView.tsx
│   │   ├── TaskDetailSheet.tsx     # <Sheet> 包 TaskDetailView，URL ?task=
│   │   ├── LightboxDialog.tsx      # <Dialog> 全屏图，URL ?fullscreen=1
│   │   ├── ShortId.tsx             # 8 字短码 + copy + tooltip 全 id
│   │   ├── ModelChips.tsx          # 前 3 + +N more
│   │   ├── StatusBadge.tsx
│   │   └── FuzzyTime.tsx           # "5 min ago" / hover ISO
│   ├── lib/
│   │   ├── api-client.ts     # fetch wrapper：JSON、401 拦截 (依赖 router/queryClient ref)
│   │   ├── queries.ts        # useMe / useDevices / useDeviceDetail / useTask
│   │   ├── search-params.ts  # range/sort/task/fullscreen 的 zod-less 校验 helper
│   │   ├── types.ts          # 从 admin server queries.ts re-export DeviceRow / TaskListItem / TaskDetail 等
│   │   ├── utils.ts          # cn() shadcn 标配
│   │   └── format.ts         # duration / size / fuzzyTime
│   └── __tests__/
│       ├── lib/api-client.test.ts
│       ├── lib/search-params.test.ts
│       └── routes/login.test.tsx
└── (server/ 已存在，本提案改 2 处)
```

### vite.config.ts 关键

```ts
export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:37378' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
```

### tailwind / 字体

复制 `apps/web/tailwind.config.ts` 的 zinc 色板与字体定义 → admin。design spec 提到的「内联 token + 后续抽 ui-tokens」放下个提案再处理。

## TanStack Router 数据加载

- 走 **Query 主导**：`beforeLoad` 只做鉴权重定向 / parse params；视图组件用 `useDevices/useDeviceDetail/useTask` hook fetch。
- search params 用 `validateSearch` parse 成强类型（手写 narrow 函数即可，不引 zod；与 BFF 风格一致）。
- `_authed.tsx` 的 `beforeLoad`：

```ts
beforeLoad: async ({ context }) => {
  await context.queryClient.ensureQueryData({
    queryKey: ['me'],
    queryFn: () => apiClient.get('/api/me'),
  }).catch(() => { throw redirect({ to: '/login' }) })
}
```

- `_authed.tasks.$taskId.tsx` 的 `beforeLoad`：

```ts
beforeLoad: async ({ params, context }) => {
  const task = await context.queryClient.ensureQueryData({
    queryKey: ['task', params.taskId],
    queryFn: () => apiClient.get(`/api/tasks/${params.taskId}`),
  })
  throw redirect({
    to: '/_authed/devices/$deviceId',
    params: { deviceId: task.device_id },
    search: { range: '7d', task: params.taskId },
  })
}
```

## URL 状态约定

| 路由 | search params |
|---|---|
| `/_authed/devices` | `range?: '1d'\|'7d'\|'30d'`（默认 `7d`），`sort?: 'last_seen'\|'today_count'\|'total_count'`（默认 `last_seen`） |
| `/_authed/devices/$deviceId` | `range?: '1d'\|'7d'\|'30d'`（默认 `7d`），`task?: string`（打开抽屉），`fullscreen?: '1'`（抽屉里再切全屏 lightbox） |

切 range/sort 直接 `navigate({ search: prev => ({...prev, range: '30d'}) })`；refresh 按钮 `queryClient.invalidateQueries({ queryKey: ['devices'] })` + `['device']` + `['task']`。

## TaskDetailView 抽屉 vs 全屏

- 列表点行 → `navigate({ search: prev => ({...prev, task: id}) })` → `<Sheet open={!!search.task}>` 渲染 `<TaskDetailView taskId={search.task} mode="sheet" />`
- 抽屉里点输出图 → `navigate({ search: prev => ({...prev, fullscreen: '1', imgIdx: 0}) })` → `<Dialog open={search.fullscreen === '1'}>` 全屏 lightbox 显示 `?idx=${search.imgIdx}`
- `/tasks/$taskId` deeplink → server redirect to 上述 sheet 形态（保证只有一条规范 URL）

## admin server 改动（2 处）

### 1. `lib/queries.ts` 的 `getTask` 返 device_id

```ts
const meta = await db.run(sql`SELECT device_id FROM tasks WHERE id = ${taskId}`)
const device_id = (meta.rows?.[0] as { device_id?: string })?.device_id ?? null
// 拼到 return
```

（具体 unmarshal shape 落地时 Drizzle bun-sqlite verify。）

### 2. `server/index.ts` 接静态托管

从 `apps/bff/src/app.ts` 复制 `serveStatic` + `serveSpaFallback` + `cacheControlFor` + MIME 表 + gzip 探测，落到 `apps/admin/server/static.ts`，去掉 BFF 特有的 SW / hero-seed 分支；在 `app.ts` 末尾加：

```ts
app.use(serveStatic({ root: resolveDistRoot() }))
app.use(serveSpaFallback({ root: resolveDistRoot() }))
```

`resolveDistRoot()` 优先取 `ADMIN_DIST_DIR` env，回退 `path.join(process.cwd(), 'apps/admin/dist')`，与 BFF 现有 `WEB_DIST_DIR` 风格对齐。

## 部署改动

### 根 `package.json`

```jsonc
"deploy:local": "pnpm --filter @image-playground/web build && \
  pnpm --filter @image-playground/admin build && \
  launchctl kickstart -k gui/$(id -u)/qlj.image-playground.bff && \
  launchctl kickstart -k gui/$(id -u)/qlj.image-playground.admin && \
  launchctl kickstart -k gui/$(id -u)/qlj.cloudflared-macmini"
```

顺序保证：bff(migration) → admin(connect) → cloudflared(reload)。

### cloudflared ingress（仓库不动）

mac mini 本地 `~/.cloudflared/config.yml` 加一条：

```yaml
- hostname: admin.image-playground.<root>
  service: http://127.0.0.1:37378
```

放在 :37377 web 规则**之前**（优先级）。具体 hostname / cert 维护在 mac mini 本地，不入仓库。

### admin server 进程已经常驻

launchd plist `qlj.image-playground.admin.plist`（commit 7fbb56b 已经落地）。`kickstart -k` 给它发 SIGTERM → 自动重启。

## 测试覆盖

| 文件 | 覆盖 |
|---|---|
| `apps/admin/src/__tests__/lib/api-client.test.ts` | fetch wrapper 401 → router.navigate('/login') + queryClient.clear() / 200 returns JSON / 5xx throws |
| `apps/admin/src/__tests__/lib/search-params.test.ts` | range / sort / task / fullscreen parse + 非法值兜底 + round-trip |
| `apps/admin/src/__tests__/routes/login.test.tsx` | 表单提交成功 → navigate /devices / 401 → 显示错误 / 429 → 显示锁定提示 |

Vitest + jsdom + RTL。**视图组件（DeviceTable、TaskDetailView 等）暂不写 RTL**，自用工具靠浏览器手测。

## 风险 / 已知边界

- **shadcn CLI 在 monorepo 配置**：`components.json` 的 `aliases.utils` 路径 `@/lib/utils`、`aliases.components` 路径 `@/components`，需要 `tsconfig.json` 的 `paths` 与 vite alias 都配 `@ → src`。落地 PR 验证一次。
- **routeTree.gen.ts 入 git**：跟官方 file-based router 推荐一致；build step 也跑一次 `tsx node_modules/.../routes-gen.js` 重新生成，避免漂移。
- **drizzle bun-sqlite 的 raw sql 返回 shape**：Plan A 已知 deviation，admin 的 queries.ts 已经 normalize 过；`getTask` 加 device_id 时遵循同样写法（取 `result.rows?.[0]`）。
- **dev 环境跨进程**：前端 `pnpm dev` (Vite :5174) 调 admin server (:37378) cookie 同源问题——Vite proxy 不会丢 cookie，但浏览器认 `Origin: http://localhost:5174` 跟 `cookie domain` 不冲突（cookie host-only on :37378）；实际通过 proxy 走 :5174 同源，cookie 设在 :5174 上没问题。dev `secure: true` cookie 会被 localhost 接受（Chrome 例外）。落地后跑一次浏览器手测确认。
- **生产同源**：admin server 同时服务 dist 和 /api，cookie host-only 在 admin.xxx 域上自洽。
- **TanStack Router context**：用 `createRootRouteWithContext<{ queryClient: QueryClient }>()` 把 queryClient 注入 context，beforeLoad 才能 ensureQueryData。

## 不做的事（明确划界）

- Tailwind v4 试点（顺延到统一升级 PR）
- `packages/server-utils/` 抽包（顺延到 admin/bff 静态托管出现分叉时）
- 视图层 RTL 覆盖（顺延到自用阶段过去、有他人协作时）
- 列表页缩略图（顺延到性能/体验明确需要时）
- Tailwind token 抽 `packages/ui-tokens`（顺延到 web 升 v4 PR）
- README / CHANGELOG（admin 是内部工具，commit message 即文档）
