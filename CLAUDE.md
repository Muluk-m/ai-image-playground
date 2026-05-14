# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

monorepo，含：

- `apps/web/` — 图像工作台前端（React + Vite，可部署到 CF Pages）；Fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 扩展而来。数据全部存在浏览器 IndexedDB。
- `apps/bff/` — 任务制 BFF（Elysia + Bun + Drizzle + SQLite），跑在 mac mini 上为 image-playground 提供异步队列模式的图像生成入口，绕开 CF Edge 100s 超时。
- `packages/shared/` — 跨 app 的协议类型（queue submit/status/result schema）。

## 技术栈

- **monorepo**：pnpm workspace + Turbo v2 + Biome
- **前端 `apps/web`**：React 19 · Vite 6 · TypeScript 5.8 · Zustand 5 · Vitest 4 · TailwindCSS 3
- **BFF `apps/bff`**：Bun · Elysia · Drizzle · SQLite，端口 37377

## 常用命令（顶层 turbo 入口）

- `pnpm test` —— 所有 app 跑测试。
- `pnpm build` —— 所有 app 构建（apps/web 内部含 `gen:channels && tsc -b && vite build`）。**typecheck 的唯一入口**。
- `pnpm typecheck` —— 所有 app 单跑 `tsc -b`。
- `pnpm dev` —— 起所有 app dev server。
- `pnpm dev:web` —— 只起 `apps/web` 的 Vite dev server。
- `pnpm lint` —— `biome check .`（format + organize imports + 启用的 linter 检查；linter 在 `biome.json` 里目前禁用，所以主要查 format/import）。
- `pnpm exec biome check --write .` —— **lint 自动修复**：同时修 format + organize imports。注意 `pnpm format` 只改 format 不动 import 顺序，**正经修 lint 错的入口是这条**，不是 `pnpm format`。
- `pnpm format` —— `biome format --write .`（仅格式化，不动 import）。

子包内还可以直接进目录跑（如 `cd apps/web && pnpm dev`）。

## 完成任务的硬性检查清单

**任何一次改完代码、提交前都要跑下面三件事**，缺一不可：

1. `pnpm exec biome check --write .` — 自动修 format + import 排序；然后 `pnpm lint` 二次确认 0 errors（biome.json 自身的 schema deprecation warning/info 是已知 noise，可忽略）
2. `pnpm typecheck` — TypeScript 跨包 build 检查
3. **测试**：顶层 `pnpm test`，或在改动涉及的 app 目录里跑 `pnpm test`

任一项不过就不要 push。本地是唯一关卡，没有 CI 兜底。

## 测试约定

- **测试库一律用 [Vitest](https://vitest.dev/)**（web 是 vitest 4；bff 现存 1 个 route 测试用 `bun:test`，因为依赖 `bun:sqlite` 等 Bun-only API；新加 bff 测试也优先 vitest，除非确实需要 Bun runtime）。新写测试 import 走：
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
  ```
  Mock 用 `vi.fn()` / `vi.spyOn()` / `vi.mock(<module>, factory)`。不要混 jest 或 bun:test 的 API。
- **测试文件统一放在 `<app>/src/__tests__/` 下**（functions 子树的测试放 `<app>/functions/__tests__/`），保留与被测代码相同的子目录结构。例：
  - 源 `apps/web/src/lib/api.ts` → 测 `apps/web/src/__tests__/lib/api.test.ts`
  - 源 `apps/web/src/features/inspiration/store.ts` → 测 `apps/web/src/__tests__/features/inspiration/store.test.ts`
  - 源 `apps/bff/src/routes/submit.ts` → 测 `apps/bff/src/__tests__/routes/submit.test.ts`
- 测试文件命名 `*.test.ts(x)`；Vitest 默认配置自动发现，不需要单独注册
- 涉及外部 IO（network / fs / sub2api）必须 mock；测试不能依赖在线服务或真实文件系统
- `vi.mock` 的字符串路径用相对路径从测试文件位置出发；测试位于 `__tests__/` 下时，到 source 的相对路径要回上若干层，例如 `apps/web/src/__tests__/lib/api.test.ts` 里 mock 源代码：
  ```ts
  vi.mock('../../lib/channels/publicChannels', () => ({ ... }))
  ```

## 部署流程

线上跑在 mac mini 上：BFF（apps/bff）通过 launchd 常驻，**同时托管 apps/web 的静态产物 + 提供 api-proxy 与 queue 路由**。CF Pages 路径已弃用，**不要再跑 `pnpm deploy:cf`**。

部署本身由仓库根的 `pnpm deploy:local` 完成：构建 `apps/web` + `launchctl kickstart` 重启 BFF。Claude push 完成后默认通过 ssh 到 mac mini 跑下面这条（**先拉代码再部署**，除非用户明确说「先不部署」）：

```sh
ssh macmini "cd /Users/qiqian/workspace/repos/qlj-image-playground && \
  git pull --rebase --autostash origin main && \
  pnpm deploy:local"
```

`--autostash` 让 mac mini 上偶尔的本地未提交改动不阻塞 rebase。命令链全用 `&&`，出现任何错误立即终止。看到 `launchctl kickstart` 那一步无报错即视为部署完成。

## 服务商架构（apps/web）

三个内建 provider，分发入口 `apps/web/src/lib/api.ts` 的 `callImageApi`：

| provider | 实现文件 | 协议 |
|---|---|---|
| `openai` / `custom-*` | `openaiCompatibleImageApi.ts` | OpenAI 兼容 `/v1/images` 或 `/v1/responses` |
| `gemini` | `geminiImageApi.ts` | Google 原生 `v1beta/models/{model}:generateContent` |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`**——浏览器 CORS preflight 对 sub2api 网关只放行前者；sub2api 后端两个 header 都接受。

## 内置 Channel 机制（apps/web）

代码：`apps/web/config/channels.json` + `apps/web/src/lib/channels/*` + `apps/web/functions/api-proxy/`。

- channel id 强制 kebab-case，`auth.secretRef` 指向环境变量名（不是真值）
- `apps/web/scripts/build-public-channels.mjs` 派生 `apps/web/src/generated/channels.public.json`（客户端可见字段，不含 secret）
- Secret 仅放 CF Pages env 变量；客户端永远不带 `Authorization`，强制经 `/api-proxy/<channelId>/<path>` 转发
- UI 必须保持完全隐藏 baseUrl / apiKey；模型可下拉切换
- Pages Function `functions/_lib/handler.ts` 用 ReadableStream + 20s 空格心跳保活，绕过 CF Edge 100s idle 超时；上游错误经 body envelope `_proxyError: true` 通知前端

## 提交规范

- 不要 `git add -A`，工作区常有未追踪的本地 deploy 配置（`.env.local`、`out.png` 等），容易夹带。**只 add 明确改动的文件**。
- Commit message 用 Conventional Commits（`feat:` / `fix(scope):` / `docs:` …）。
- 在 monorepo 内通常用 scope 指 app，如 `feat(web): ...` / `feat(bff): ...`。

## Spec / Plan 流程

复杂改动用 [superpowers](https://github.com/anthropics/skills) 流程：

- `docs/superpowers/specs/` —— 设计文档（brainstorming 阶段产出）
- `docs/superpowers/plans/` —— 实现计划（writing-plans 阶段产出）

新功能建议先 spec → plan → 执行。

## Queue 模式（apps/web + apps/bff）

为绕开 CF Edge 100s idle timeout（生图请求 > 100s 必触发 524），引入 BFF 队列模式：

- 前端按 fal.ai-style 协议跟 BFF 交互：`submit → polling → fetch result`，三个端点都是 < 1s 快请求
- BFF 跑在 mac mini，本机 localhost 调 sub2api，**不经过 CF Edge HTTP 层**，任务多久都不限
- channel 在前端通过 `VITE_BFF_QUEUE_CHANNELS` 注入（JSON 数组），跟 builtin-edge channels 平行
- channel.kind 为 `'openai-queue'` 或 `'gemini-queue'`，dispatch 走 `apps/web/src/lib/channels/queueClient.ts`
- 协议 types 在 `packages/shared/src/queue-protocol.ts`

部署：mac mini 上 `cd apps/bff && pnpm start`，cf tunnel 把 :37377 暴露成公网域名，前端 env 填该域名即可。详见 `apps/bff/README.md`。

## 其它要点（apps/web）

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 `apps/web/src/lib/fetchProfileModels.ts`，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
