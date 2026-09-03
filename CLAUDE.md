# CLAUDE.md

本文件给 Claude Code（claude.ai/code）当作工作约定。**严格遵守**，不要按通用 monorepo 直觉走。

## 项目概况

`ai-image-playground` — AI 生图工作台。fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，扩展了 Gemini 原生协议、异步队列模式、可选 BFF 后端、内置 channel discovery。

pnpm workspace + Turbo v2 + Biome：

- `apps/web/` — 前端工作台（React 19 + Vite 6 + TypeScript 5.8 + Zustand 5 + Tailwind 3 + Vitest 4）。历史 / 配置全存浏览器 IndexedDB。
- `apps/bff/` — **可选**任务队列 BFF（Elysia + Bun + Drizzle + PostgreSQL via `bun:sql`）。监听 `:37377`，托管 web/dist 同源，跑长任务（绕浏览器 / Edge 长超时）。
- `apps/admin/` — 可选运维面板（Bun + Elysia 服务端，端口 37378；Vite + TanStack Router + shadcn 前端）。HMAC cookie 鉴权；数据库连接只读，用户与运营写操作一律代理到 BFF。
- `packages/shared/` — 跨 app 协议类型（`runtime-config.ts` / `channel-discovery.ts` / `queue-protocol.ts`）。

两种部署形态（详见仓库根 `README.md`）：

- **Tier 1：纯静态** — 仅 `apps/web/dist`，BYOK only，浏览器直连上游
- **Tier 2：静态 + BFF** — Docker 镜像或裸跑 BFF + web/dist 同进程托管

各 app 的内部约定（服务商架构、内置 channel、BFF 定位、queue 协议等）放在 `apps/web/CLAUDE.md` 与 `apps/bff/CLAUDE.md`，改到对应目录时自动加载。

## 常用命令

顶层 turbo 入口：

- `pnpm test` — 所有 app 跑测试
- `pnpm build` — 所有 app 构建（apps/web 内部含 `gen:hero-seed && tsc -b && vite build`）。**typecheck 的唯一入口**。
- `pnpm typecheck` — 所有 app 单跑 `tsc -b`
- `pnpm dev` — 起所有 app 的 dev server
- `pnpm dev:web` — 只起 `apps/web` 的 Vite dev server
- `pnpm lint` — `biome check .`（format + organize imports + linter；受限引用规则会强制私有树边界）
- `pnpm exec biome check --write .` — **lint 自动修复**：同时修 format + organize imports。注意 `pnpm format` 只改 format 不动 import 顺序，**正经修 lint 错的入口是这条**。
- `pnpm format` — `biome format --write .`（仅格式化，不动 import）

子包内也可以直接进目录跑：`cd apps/web && pnpm dev`、`cd apps/bff && pnpm dev` 等。

## 完成任务的硬性检查清单

**任何一次改完代码、提交前都要跑下面三件事**，缺一不可：

1. `pnpm exec biome check --write .` — 自动修 format + import 排序；然后 `pnpm lint` 二次确认 0 errors（biome.json 自身的 schema deprecation warning/info 是已知 noise，可忽略）
2. `pnpm typecheck` — TypeScript 跨包 build 检查
3. **测试**：顶层 `pnpm test`，或在改动涉及的 app 目录里跑 `pnpm test`。PostgreSQL 集成测试需要 `TEST_DATABASE_URL`（本机例：`TEST_DATABASE_URL=postgres://qiqian@127.0.0.1:5432/aip_test`），未设置会直接报错失败。

任一项不过就不要 push。本地是唯一关卡，没有 CI 兜底。

## 测试约定

- **BFF / Admin 后端测试使用 `bun:test`**：数据库与对象存储客户端依赖 Bun runtime，不要换成 Vitest。前端测试继续使用 [Vitest](https://vitest.dev/) 4。不要在同一测试文件混用两套 API。
- **测试文件统一放在 `<app>/src/__tests__/` 下**，保留与被测代码相同的子目录结构。例：
  - 源 `apps/web/src/lib/api.ts` → 测 `apps/web/src/__tests__/lib/api.test.ts`
  - 源 `apps/bff/src/routes/submit.ts` → 测 `apps/bff/src/__tests__/routes/submit.test.ts`
- 测试文件命名 `*.test.ts(x)`；Vitest 默认配置自动发现，不需要单独注册
- 私有树包不强制使用 `src/` 目录；其测试放在相邻模块的 `__tests__/` 下（例如 `private/apps/bff/billing/__tests__/`）。
- 外部网络 / 上游 API 必须 mock，测试不能依赖在线服务或宿主机固定文件。PostgreSQL 集成测试可通过 `TEST_DATABASE_URL` 创建并清理独立测试库；文件存在性接缝测试可使用测试进程创建并清理的临时目录。
- `vi.mock` 的字符串路径用相对路径从测试文件位置出发；测试位于 `__tests__/` 下时，到 source 的相对路径要回上若干层，例如 `apps/web/src/__tests__/lib/api.test.ts` 里 mock 源代码：
  ```ts
  vi.mock('../../lib/channels/publicChannels', () => ({ ... }))
  ```

## Runtime 配置

[`packages/shared/src/runtime-config.ts`](./packages/shared/src/runtime-config.ts) 定义 schema。
`runtime-config.json` 只包含连接 BFF 前必须知道的 `bff.enabled` 与 `bff.baseUrl`；schema
无效或文件不存在时回退到 `BAKED_DEFAULTS`（`bff.enabled=false`）。能力只能由 BFF 求值，前端并行读取
`/api/capabilities` 与 channel 列表，清单不可用时全部按关闭处理，禁止把能力写回 runtime
配置。Docker entrypoint 从 env 生成 runtime 配置；裸跑或纯静态部署可自行生成。

## 私有树接缝

`private/apps/{bff,web,admin}` 是可选 overlay 工作区；目录缺席时公开树必须独立
typecheck、测试和构建。公开树只允许以下三个审计接缝引用 `private/`：

- `apps/bff/src/lib/private-overlay.ts`：任务事务 hook 与私有 BFF routes
- `apps/web/src/lib/privateOverlay.tsx`：用户侧 header、提交门禁和状态 UI
- `apps/admin/src/lib/private-overlay.tsx`：运营概览、用户摘要和用户详情 UI

私有 Admin 的所有写操作经 `/api/private/*` 代理到 BFF 的
`/internal/admin/private/*`；Admin 数据库角色保持 SELECT-only。添加私有模块后，
必须同时跑公开包和对应私有包的 typecheck，并分别验证「目录存在」与「目录缺席」构建。
验证 overlay 构建一律 `pnpm build --force`：turbo 的输入哈希看不见 gitignored 的 `private/`，
不加 `--force` 会命中不带 overlay 的缓存产物。

私有迁移新建 schema 时，必须把 schema 名登记到部署的 `POSTGRES_EXTRA_SCHEMAS` 并重跑
provision，否则 SELECT-only 的备份角色读不到它，每日 `pg_dump` 全库失败。

## 版本模型与分支

**服务端只有一套。** `apps/bff`、`apps/admin` 服务端、`packages/db` 同时兼容收费与免费部署：
能力注册表 deny by default，由运营配置 `operator-config.json` 决定开哪些能力，代码不分版本。

**收费与免费的区别只在前端构建参数。** 构建时带上私有 overlay 就是收费形态，不带就是免费形态：

- 免费：`./scripts/app-compose.sh build <image>`
- 收费：`./scripts/app-compose.sh build-private <image>`（`--build-arg PRIVATE_OVERLAY_PRESENT=true` + `--build-context private-overlay=private/`）

**分支：** `main` 是唯一长期分支，所有改动开 PR 直合 main，没有其他长期分支。

**形态由构建输入决定，不由分支决定：**

- 收费 = `main` + 仓库根 `private/` overlay（来源 `Muluk-m/ai-image-playground-private`，clone 到 `private/`）+ 仓库外 env 文件
- 免费 = `main` 不带 overlay

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

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues of `Muluk-m/ai-image-playground` (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
