## Why

内置 profile 的 API key 当前直接打进客户端 bundle (`DEFAULT_BUILTIN_PROFILES` / `VITE_BUILTIN_PROFILES`)，任何拿到部署 URL 的用户都能从源码里抽走密钥；这让"为团队预置可用模型"和"密钥安全"无法共存。同时 `provider` 概念在客户端散落（`apiProfiles.ts` / `builtinProfiles.ts` / `providerModels.ts` / `customProviders`），新增内置渠道要改多处。本次引入一套以"边缘节点持密钥 + 仓库内 JSON 单一真源"为核心的 Provider/Channel schema。

## What Changes

- 新增 `config/channels.json` 作为内置 channel 的唯一真源，字段含 `kind`、`baseUrl`、`auth.secretRef`、`models[]`、`defaults`、`allowedPaths`；真实密钥仅存在 Cloudflare Pages 环境变量中。
- 新增 Cloudflare Pages Function `functions/api-proxy/[channelId]/[[path]].ts`，负责：channelId 查表 → path 白名单校验 → 注入 `Authorization` / `?key=` → 透传上游响应。
- 新增构建脚本 `scripts/build-public-channels.mjs`，从 `channels.json` 派生 `src/generated/channels.public.json`（剔除 `baseUrl` / `auth` / `secretRef` / `allowedPaths`）打进 bundle，避免运行时再发现请求。
- 引入双层客户端类型：`PublicChannel`（无凭据视图）+ `ClientProfile`（`source: 'builtin-edge' | 'user-byok'` 区分）。builtin profile 仅持 `channelId + selectedModelId`，运行时偏好继承 channel defaults 且不可改；BYOK profile 保留旧 `ApiProfile` 全部行为（含 `apiKey` 在客户端），但**把单 `model: string` 字段升级为 `models: string[] + selectedModelId: string`**：用户可以在同一个 BYOK profile 下预存多个模型（来源 = provider 预置 + 上游 `/v1/models` 拉取 + 手动输入），运行时在 InputBar 现场切换，不再需要为每个模型新建一份 profile。
- 两条分支的模型语义对齐：builtin-edge 从 `PublicChannel.models[]` 读，user-byok 从 `ClientProfile.models[]` 读；当前激活模型统一为 `selectedModelId`。`InputBar` 跨 profile 的模型 dropdown、`TaskCard` 的 model tag 显示、URL `?model=` 参数解析都改读 `selectedModelId`。
- **BREAKING** 移除 fal.ai 支持：删除 `falAiImageApi.ts`、`@fal-ai/client` 依赖、`TaskRecord.falRequestId/falEndpoint/falRecoverable`、`provider:'fal'` 分支、相关默认常量与 provider 模型清单。
- **BREAKING** 旧 builtin profile（key 打 bundle 模式）整体下线；存量 `localStorage` 中的 builtin profile 在启动时一次性迁移为 `source: 'builtin-edge'`，丢弃 `apiKey`；BYOK profile 不受影响。
- 客户端 `callImageApi` 改为按 `ClientProfile.source` 分派：builtin-edge 走 `/api-proxy/<channelId>/<path>`（不带 Authorization）；user-byok 走今天的 OpenAI/Gemini adapter（保留 `apiProxy` 同源代理选项）。
- `customProviders` (HTTP 模板) 不在本次实现，但在 `ProviderKind` 枚举中保留 `'http-template'` 占位，以免后续再做破坏性调整。

## Capabilities

### New Capabilities
- `channel-config`: 仓库内 `channels.json` schema、`PublicChannel` 派生规则、构建脚本契约。
- `edge-proxy`: Pages Function 的路由形态、path 白名单、auth 注入、错误回传语义。
- `client-profile`: 客户端 `ClientProfile` 双形态（`builtin-edge` / `user-byok`）的字段、迁移与 UI 行为约束；BYOK 形态原生支持每 profile 多模型（`models[] + selectedModelId`），模型来源为预置 + 上游拉取 + 手动输入。

### Modified Capabilities
（仓库 `openspec/specs/` 当前为空，本次为首份 spec，不存在 modified。）

## Impact

- **代码**：`src/lib/api.ts`、`apiProfiles.ts`、`builtinProfiles.ts`、`providerModels.ts`、`devProxy.ts`、`types.ts`、`store.ts`、`urlSettings.ts`；新增 `src/lib/channels/*`、`functions/**`、`config/channels.json`、`scripts/build-public-channels.mjs`、`src/generated/`；UI 侧 `SettingsModal.tsx`、`InputBar.tsx`、`ModelCombobox.tsx`、`TaskCard.tsx` 需适配 `models[] + selectedModelId` 新形态（BYOK profile 表单从单输入框改为多选列表 + 添加/删除/拉取动作）。
- **依赖**：移除 `@fal-ai/client`。
- **部署**：Cloudflare Pages 项目需要新增环境变量（如 `SUB2API_GEMINI_FLASH_KEY`、`OPENAI_API_KEY`）；`wrangler.jsonc` 保持 assets-only 即可，Pages Functions 自动识别 `functions/` 目录。
- **数据**：用户 `localStorage` 中的旧 builtin profile 自动迁移；`TaskRecord` 中 fal 相关字段一次性清理；旧 BYOK profile 的 `model: string` 迁移为 `models: [model], selectedModelId: model`，老的 `builtinProfileModelSelections` 映射并入 builtin-edge profile 的 `selectedModelId`。
- **文档**：`README.md` 删除 fal 段落、新增 "添加内置 channel" 工作流；`.env.example` 删除 `VITE_BUILTIN_PROFILES`，新增 Pages secrets 提示。
- **不变**：BYOK 用户行为、`apiProxy` 同源代理开关（仅 BYOK 可见）、自定义 HTTP 模板（保持现状，下版再统一）。
