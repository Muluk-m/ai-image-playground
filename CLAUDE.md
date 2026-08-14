# CLAUDE.md

本文件给 Claude Code（claude.ai/code）当作工作约定。**严格遵守**，不要按通用 monorepo 直觉走。

## 项目概况

`ai-image-playground` — AI 生图工作台。fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，扩展了 Gemini 原生协议、异步队列模式、可选 BFF 后端、内置 channel discovery。

pnpm workspace + Turbo monorepo：

- `apps/web/` — 前端工作台（React 19 + Vite 6 + TypeScript 5.8 + Zustand 5 + Tailwind 3 + Vitest 4）。历史 / 配置全存浏览器 IndexedDB。
- `apps/bff/` — **可选** 任务队列 BFF（Elysia + Bun + Drizzle + SQLite）。监听 `:37377`，托管 web/dist 同源，跑长任务（绕浏览器 / Edge 长超时）。
- `apps/admin/` — 可选运维面板（Bun + Elysia 服务端 + Vite + TanStack Router 前端 + shadcn）。HMAC cookie 鉴权，read-only 查任务和设备。
- `packages/shared/` — 跨 app 协议类型（`runtime-config.ts` / `channel-discovery.ts` / `queue-protocol.ts`）。

两种部署形态（详见仓库根 `README.md`）：

- **Tier 1：纯静态** — 仅 `apps/web/dist`，BYOK only，浏览器直连上游
- **Tier 2：静态 + BFF** — Docker 镜像或裸跑 BFF + web/dist 同进程托管

前端在 boot 时 fetch `./runtime-config.json` 决定走哪一形态（`bff.enabled` 开关）；文件不存在 → BAKED_DEFAULTS (`bff.enabled=false`)。

## 技术栈基线

- **monorepo**：pnpm workspace + Turbo v2 + Biome
- **前端 `apps/web`**：React 19 · Vite 6 · TypeScript 5.8 · Zustand 5 · Vitest 4 · TailwindCSS 3
- **BFF `apps/bff`**：Bun · Elysia · Drizzle ORM · SQLite (`bun:sqlite`)，端口 37377
- **admin `apps/admin`**：服务端 Bun + Elysia (端口 37378)；前端 Vite + TanStack Router + shadcn

## 常用命令

顶层 turbo 入口：

- `pnpm test` — 所有 app 跑测试
- `pnpm build` — 所有 app 构建（apps/web 内部含 `gen:hero-seed && tsc -b && vite build`）。**typecheck 的唯一入口**。
- `pnpm typecheck` — 所有 app 单跑 `tsc -b`
- `pnpm dev` — 起所有 app 的 dev server
- `pnpm dev:web` — 只起 `apps/web` 的 Vite dev server
- `pnpm lint` — `biome check .`（format + organize imports + 启用的 linter 检查；linter 在 `biome.json` 里目前禁用，主要查 format/import）
- `pnpm exec biome check --write .` — **lint 自动修复**：同时修 format + organize imports。注意 `pnpm format` 只改 format 不动 import 顺序，**正经修 lint 错的入口是这条**。
- `pnpm format` — `biome format --write .`（仅格式化，不动 import）

子包内也可以直接进目录跑：`cd apps/web && pnpm dev`、`cd apps/bff && pnpm dev` 等。

## 完成任务的硬性检查清单

**任何一次改完代码、提交前都要跑下面三件事**，缺一不可：

1. `pnpm exec biome check --write .` — 自动修 format + import 排序；然后 `pnpm lint` 二次确认 0 errors（biome.json 自身的 schema deprecation warning/info 是已知 noise，可忽略）
2. `pnpm typecheck` — TypeScript 跨包 build 检查
3. **测试**：顶层 `pnpm test`，或在改动涉及的 app 目录里跑 `pnpm test`

任一项不过就不要 push。本地是唯一关卡，没有 CI 兜底。

## 测试约定

- **测试库一律用 [Vitest](https://vitest.dev/)**（web 是 vitest 4；bff 现存测试用 `bun:test`，因为依赖 `bun:sqlite` 等 Bun-only API；新加 bff 测试也优先 vitest，除非确实需要 Bun runtime）。新写测试 import 走：
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
  ```
  Mock 用 `vi.fn()` / `vi.spyOn()` / `vi.mock(<module>, factory)`。不要混 jest 或 bun:test 的 API。
- **测试文件统一放在 `<app>/src/__tests__/` 下**，保留与被测代码相同的子目录结构。例：
  - 源 `apps/web/src/lib/api.ts` → 测 `apps/web/src/__tests__/lib/api.test.ts`
  - 源 `apps/bff/src/routes/submit.ts` → 测 `apps/bff/src/__tests__/routes/submit.test.ts`
- 测试文件命名 `*.test.ts(x)`；Vitest 默认配置自动发现，不需要单独注册
- 涉及外部 IO（network / fs / 上游 API）必须 mock；测试不能依赖在线服务或真实文件系统
- `vi.mock` 的字符串路径用相对路径从测试文件位置出发；测试位于 `__tests__/` 下时，到 source 的相对路径要回上若干层，例如 `apps/web/src/__tests__/lib/api.test.ts` 里 mock 源代码：
  ```ts
  vi.mock('../../lib/channels/publicChannels', () => ({ ... }))
  ```

## 服务商架构（apps/web）

前端 dispatch 入口在 [`apps/web/src/lib/api.ts`](./apps/web/src/lib/api.ts) 的 `callImageApi`，按 profile.source 分两条路径：

| profile.source | 实现路径 | 协议 |
|---|---|---|
| `user-byok` | `openaiCompatibleImageApi.ts` / `geminiImageApi.ts` | 浏览器直连用户填的 baseUrl |
| `builtin-edge` | `queueClient.ts` | 浏览器 → BFF queue（`submit / poll / fetch`） |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`** — 浏览器 CORS preflight 对常见中转网关只放行前者；后端代理通常两个 header 都接受。

## 内置 channel 机制（apps/bff）

代码：[`apps/bff/channels.json`](./apps/bff/channels.json) + [`apps/bff/src/lib/channels.ts`](./apps/bff/src/lib/channels.ts) + [`apps/bff/src/routes/channels.ts`](./apps/bff/src/routes/channels.ts)。

- channel id 强制 kebab-case，`auth.secretRef` 指向环境变量名（**UPPER_SNAKE_CASE，不是真值** — 校验器会拒绝长得像 `sk-...` / `AIza...` 的字符串）
- 真实 API key 只在 BFF 进程的 env 里；客户端永远不带 `Authorization`
- BFF 启动时 `initChannels()` 解析 channels.json + 解析 `process.env[secretRef]`；缺 secret 只 warn 不 fatal
- `GET /api/channels` 暴露 sanitized channel 列表（不含 `baseUrl` / `auth` / `allowedPaths`）给前端 boot 时拉
- UI 必须保持完全隐藏 baseUrl / apiKey；模型可下拉切换
- **channels.json 数组顺序是产品契约**：`channels[0]` 是新访客的默认模型（前端按序注入 profile 并兜底选第一个）。新增 channel 往后排
- worker 调上游默认走 `UPSTREAM_BASE_URL` 通用网关（env 约定 baseUrl **不含**版本段）；独立直连上游的 channel 要加进 `upstream.ts` 的 `DIRECT_CHANNEL_IDS`，baseUrl/key 单源 channels.json（约定 baseUrl **含**版本段，如 `.../v1`）

## Runtime 配置（apps/web）

[`packages/shared/src/runtime-config.ts`](./packages/shared/src/runtime-config.ts) 定义 schema。前端 boot 时 fetch `./runtime-config.json`，schema 校验失败 / 文件不存在都 fallback 到 `BAKED_DEFAULTS`（`bff.enabled=false`）。

operator 在部署时写这个文件 — Docker entrypoint (`scripts/docker-entrypoint.sh`) 把 env 模板化写出来；裸跑 / 纯静态部署 operator 自己手写或脚本生成。

## 提交规范

- 不要 `git add -A`，工作区常有未追踪的本地配置（`.env.local`、`out.png` 等），容易夹带。**只 add 明确改动的文件**。
- Commit message 用 Conventional Commits（`feat:` / `fix(scope):` / `docs:` …）。
- 在 monorepo 内通常用 scope 指 app，如 `feat(web): ...` / `feat(bff): ...` / `feat(admin): ...`。

## Spec / Plan 流程

复杂改动用 [superpowers](https://github.com/anthropics/skills) / openspec 流程：

- `openspec/changes/<name>/proposal.md` — Why + What Changes + Capabilities
- `openspec/changes/<name>/design.md` — 设计细节、决策表、风险
- `openspec/changes/<name>/tasks.md` — 可执行任务清单

新功能建议先 proposal → design → tasks → 执行。简单 bug fix 可以直接动手。

## BFF 定位

BFF（`apps/bff/`）在整个 playground 里只做四件事：

1. **任务队列代理** — 绕浏览器 / Edge / CF Pages 这类平台的 100s idle timeout（Gemini 3 Pro Image 单张能跑 30-300s）。前端发 `submit / status / fetch` 三段 < 1s 快请求，BFF 内部跑长 fetch 调上游。
2. **Secret 守门人** — 上游 API key 只在 BFF 进程 env 里，浏览器永远拿不到；这是「内置 channel」能让没 key 的用户也能用的前提。
3. **持久化 + 幂等** — SQLite 存 task，浏览器刷新 / 关 tab 后用 `client_request_id` 幂等恢复，不重复扣额度。
4. **托管前端静态产物** — `apps/web/dist` 由 BFF serve（`STATIC_DIR` env），跟 BFF 同源省 CORS preflight。

**BFF 不做**：协议翻译（OpenAI / Gemini 字段透传给上游）；**BYOK profile 完全绕过 BFF**（前端直接 fetch 用户填的 baseUrl，BFF 看不到也存不了 BYOK 的 key）。

## Queue 模式协议（apps/web ↔ apps/bff）

- 前端按 fal.ai-style 协议跟 BFF 交互：`submit → polling → fetch result`，三个端点都是 < 1s 快请求
- channel kind 在前端层叫 `openai-queue` / `gemini-queue`；到 BFF URL 段 `/v1/queue/{provider}/{model}/submit` 时映射为 `openai-compat` / `gemini`（参见 `queueClient.ts` 的 `toQueueProvider`）
- 协议 types 在 [`packages/shared/src/queue-protocol.ts`](./packages/shared/src/queue-protocol.ts)
- BFF channel 发现协议 types 在 [`packages/shared/src/channel-discovery.ts`](./packages/shared/src/channel-discovery.ts)

## 其它要点（apps/web）

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 `apps/web/src/lib/fetchProfileModels.ts`，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- 灵感库 (`apps/web/public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
