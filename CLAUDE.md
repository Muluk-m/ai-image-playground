# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

Fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，已扩展为自部署图片工作台：新增 `gemini` 服务商 + 内置 profile 机制。数据全部存在浏览器 IndexedDB，无后端。

## 技术栈

React 19 · Vite 6 · TypeScript 5.8 · Zustand 5 · Vitest 4 · TailwindCSS 3。

## 常用命令

- `npm test` —— Vitest 单跑全量。**修改逻辑/类型后必须跑**。
- `npm run build` —— `tsc -b && vite build`。**typecheck 的唯一入口**（没有独立 lint script）。
- `npm run dev` —— 启 Vite dev server。
- `npm run mock:api` —— `scripts/mock-image-api.mjs`，本地 mock OpenAI 图像 API。
- `pnpm deploy:cf` —— build + Cloudflare Pages 部署（项目名 `image-playground`）。

无 `npm run lint`。任何「lint 通过」断言都靠 `tsc -b`。

## 部署流程

仓库**没有配置 CI 自动部署**：push 到 `main` 之后必须手动执行一次 `pnpm deploy:cf` 才能上线。完成 push 后默认执行这一步，除非用户明确说先不部署。

## 服务商架构

三个内建 provider，分发入口 `src/lib/api.ts` 的 `callImageApi`：

| provider | 实现文件 | 协议 |
|---|---|---|
| `openai` / `custom-*` | `openaiCompatibleImageApi.ts` | OpenAI 兼容 `/v1/images` 或 `/v1/responses` |
| `gemini` | `geminiImageApi.ts` | Google 原生 `v1beta/models/{model}:generateContent` |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`**——因为浏览器 CORS preflight 对 sub2api 网关只放行前者；sub2api 后端两个 header 都接受。

## 内置 Profile 机制

代码：`src/lib/builtinProfiles.ts`、`apiProfiles.ts` 的 `isBuiltinProfile` / `BUILTIN_PROFILE_ID_PREFIX`。

- id 强制 `builtin-` 前缀
- 数据源：`VITE_BUILTIN_PROFILES`（JSON 字符串 env）优先，缺省时用 `DEFAULT_BUILTIN_PROFILES` 常量
- **测试模式（`import.meta.env.MODE === 'test'`）下不加载兜底**，避免污染单测期望
- 持久化时被剥离：`getPersistedState`（store.ts）和 `exportData` 都过滤 `builtin-*`
- UI 上必须保持完全隐藏：编辑表单替换为「内置模型」提示框；复制 / 复制导入 URL 按钮 hidden；删除按钮 hidden
- 当前的 sub2api apiKey 已硬编码进 git 历史，若仓库变成 public 必须先 revoke + filter-repo 清理

## normalizeSettings 循环 import 陷阱

`DEFAULT_SETTINGS` 在 `apiProfiles.ts` 模块顶层调用 `normalizeSettings(...)`，而后者默认会调用 `getBuiltinProfiles()`（来自 `builtinProfiles.ts`，循环依赖）。**必须显式传 `{ builtinProfiles: [] }`** 绕开 TDZ，否则会报 `Cannot access 'cached' before initialization`。

## 提交规范

- 不要 `git add -A`，工作区里常有未追踪的本地 deploy 配置（vercel.json / wrangler.jsonc 删改、`.env.local`、`out.png` 等），容易夹带。**只 add 明确改动的文件**。
- Commit message 用 Conventional Commits（`feat:` / `fix(scope):` / `docs:` …）。

## Spec / Plan 流程

复杂改动用 [superpowers](https://github.com/anthropics/skills) 流程：

- `docs/superpowers/specs/` —— 设计文档（brainstorming 阶段产出）
- `docs/superpowers/plans/` —— 实现计划（writing-plans 阶段产出）

新功能建议先 spec → plan → 执行。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 `src/lib/fetchProfileModels.ts`，结果缓存在 store 的 `profileModelCache`
- 内置 profile 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinProfileModelSelections` 字段持久化
