## Context

当前 provider 体系散落在 `src/lib/apiProfiles.ts`、`builtinProfiles.ts`、`providerModels.ts`、`customProviders` 几处，且内置 profile 的 `apiKey` 通过 `DEFAULT_BUILTIN_PROFILES` / `VITE_BUILTIN_PROFILES` 直接打进客户端 bundle——任何拿到部署 URL 的人都能从 source map 抽走密钥。生产部署形态是 Cloudflare Pages（见 `wrangler.jsonc` 的 assets-only 配置），具备运行 Pages Functions 的能力，但目前未启用任何 server-side 逻辑；Docker/Nginx 路径下虽有 `/api-proxy/` 透传，也只做路径转发不注入密钥。

本设计在保持 BYOK（bring your own key）路径完全不变的前提下，引入第二条"边缘持密钥"通道，把"团队预置可用模型"和"密钥安全"解耦。

## Goals / Non-Goals

**Goals:**

- 内置 channel 的真实密钥永不进入仓库、bundle 或客户端运行时；唯一物理位置是 Cloudflare Pages 环境变量。
- `config/channels.json` 是单一真源：增删 channel = 改一处 JSON + 加/删一个 Pages secret。
- 客户端零额外网络请求即可发现可用的内置 channel（构建期 inline）。
- 现有 BYOK 用户的体验、`apiProxy` 同源代理、UI、本地 profile 完全不破坏。
- Schema 可向后扩展：新 provider 协议只需新增 adapter 文件 + `ProviderKind` 枚举值。

**Non-Goals:**

- 不实现胖网关（如 `POST /api/generate` 抽象层）；本次坚持薄代理。
- 不实现自定义 HTTP 模板的边缘变体；`customProviders` 现状保留，schema 仅占位。
- 不实现 channel 级配额、审计、模型路由策略，留待后续 capability。
- 不支持 fal.ai——整体删除而非迁移。
- 不引入数据库 / KV，配置静态化即可。

## Decisions

### Decision 1: 边缘载体 = Cloudflare Pages Functions

仓库已用 wrangler 部署 Pages，`functions/` 目录会被自动识别为 Pages Functions，零新增工具链。Vercel Edge 虽然 `vercel.json` 也存在，但部署主路径是 Pages，选其一避免双轨。

- **替代**：独立 Cloudflare Worker（额外项目）、Vercel Edge、自托管 Node。
- **取舍**：Pages Functions 与现有 assets 共享域名/部署管道，无需跨域；Worker 单独项目反而增加运维点。

### Decision 2: 双层 schema（Channel × ClientProfile）

```
ProviderKind  ── kind ──► ProviderChannel ── channelId ──► ClientProfile
  (代码枚举)              (config/channels.json)            (localStorage)
```

- **ProviderKind**：`'openai-compat' | 'gemini'`（fal 删除；`'http-template'` 占位预留）。决定 adapter 行为，不在 JSON 中可配。
- **ProviderChannel**（server side, `config/channels.json`）：一组上游凭据 + 可用模型 + 路径白名单。
- **PublicChannel**（构建期派生）：`ProviderChannel` 剔除 `baseUrl/auth/secretRef/allowedPaths` 后的客户端视图。
- **ClientProfile**（client side）：
  - `source: 'builtin-edge'` 仅持 `channelId + selectedModelId`，可选模型来自 `PublicChannel.models[]`（不可在客户端编辑）。
  - `source: 'user-byok'` 持全套字段含 `apiKey`，**模型字段由旧 `model: string` 升级为 `models: string[] + selectedModelId: string`**，可在客户端自由增删；运行时偏好（`apiMode`、`codexCli`、`apiProxy`、`responseFormatB64Json`、`timeout`）保留在 `preferences` 下。
  - 两条分支对外暴露统一 helper `getSelectedModel(profile, publicChannels): string`，请求层只依赖 `selectedModelId`，不区分 source。

- **替代**：保留单层 `ApiProfile`，在 `provider` 字段上加 `'builtin-edge'` 伪 kind。
- **取舍**：单层方案让"客户端可见 vs 不可见"字段混在同一类型里，类型系统不能强制"builtin 无 apiKey"。双层稍重但语义清晰、误用难发生。

### Decision 3: 客户端通过构建期 inline 发现 channel，不发现请求

构建脚本 `scripts/build-public-channels.mjs` 在 `vite build` 之前读 `config/channels.json`，写入 `src/generated/channels.public.json`，被 `src/lib/channels/publicChannels.ts` 静态 import。

- **替代**：运行时 `GET /api/channels/public`（Pages Function 实现）。
- **取舍**：运行时方案灵活（不改 bundle 也能加 channel），但增加一次启动请求、需要缓存策略、且本项目场景下 channel 列表变化频率约等于发版频率，inline 简单到极致。

### Decision 4: Auth 注入分两种类型，URL path 强白名单

`auth.type ∈ { 'bearer', 'query-key' }`：

- `bearer`：`Authorization: Bearer ${env[secretRef]}`（OpenAI、sub2api OpenAI 兼容）
- `query-key`：URL append `?key=${env[secretRef]}` 或自定义 header（Gemini 风格；header 名通过 `auth.headerName` 可选指定）

`allowedPaths` 是字符串数组，请求 path 必须**完全匹配**其中一项（不做 prefix 匹配，避免 path traversal）。例：`["images/generations", "images/edits", "responses"]`。

- **替代**：正则白名单、无白名单（信任 channel）。
- **取舍**：channel 的密钥若被一个意外端点（如上游某个非图像 API）使用，可能造成费用或合规问题；显式 enum 是最简稳妥的 SSRF/滥用闸口。

### Decision 5: builtin 运行时偏好不可改，BYOK 全可改

builtin channel 的 `defaults`（`apiMode`、`timeout`、`responseFormatB64Json`、`codexCli`）作为该 channel 不变量；UI 在选中 builtin profile 时把这些字段以只读形式展示。BYOK profile 保留今天 `ApiProfile` 全部可编辑字段。

- **替代**：channel 给默认，profile 可覆盖。
- **取舍**：同一上游 channel 的协议形态本就是固定的（sub2api Gemini 永远是 `images` 模式），允许用户覆盖会引入"用户改坏不可恢复"的支持成本。BYOK 是用户自家凭据，自负盈亏。

### Decision 6: fal.ai 直接删除而非迁移

- 删 `src/lib/falAiImageApi*.ts`、`@fal-ai/client`、`TaskRecord.fal*` 字段、`provider:'fal'` 分支、`DEFAULT_FAL_*` 常量、`providerModels.ts` 中 `fal` key。
- 启动迁移：localStorage 中 `provider === 'fal'` 的 profile **保留壳但标记为不可用**（避免直接 throw），UI 显示一次性 toast 提示用户删除。或更激进：迁移时直接过滤掉。本设计采纳**过滤掉**——fal 用户量未知但本应用主要面向 OpenAI/Gemini，且降低后续维护负担。

### Decision 7: builtin-edge 强制走 `/api-proxy/`，不暴露 `apiProxy` 开关

builtin profile 下 UI 不再渲染 `apiProxy` 开关；客户端 dispatch 时硬编码到 `/api-proxy/<channelId>/<path>`。`apiProxy` 字段从 `ClientProfile (source='builtin-edge')` 类型里删除；BYOK 保留。

### Decision 8a: BYOK profile 的多模型与模型来源

每个 BYOK profile 持 `models: string[]`（去重、保序）+ `selectedModelId`。模型来源分三层叠加，按优先级在 UI 中合并展示：

1. **Provider 预置**（`src/lib/providerModels.ts`）：按 `provider` 给出 hardcoded 常用模型清单（OpenAI、Gemini）。仅作为候选池，不自动塞进 `models[]`。
2. **上游拉取**（`fetchProfileModels`）：保留现有 SettingsModal 中的"拉取模型"按钮语义；拉取结果存到运行时 `profileModelCache[profile.id]`（不持久化到 `models[]`，避免噪音）。
3. **用户勾选/手填**：UI 把候选池（预置 + cache）渲染为带 checkbox 的列表，勾选则加入 `profile.models[]`；额外提供"手动添加"输入行，让用户输入任意模型名（如 fine-tune 型号 `ft:gpt-image-2:org::xxx`）。

约束：

- `selectedModelId` 必须 ∈ `profile.models[]`；持久化时若不满足，回退为 `models[0]` 并触发一次 toast。
- `profile.models` 至少含 1 项（迁移时由旧 `model` 字段填入）。
- 同一 profile 内允许任意模型形态字符串；adapter 只把 `selectedModelId` 透传到上游 body，不在客户端校验合法性。

替代方案：把 `models` 改为 `Map<modelId, { displayName, addedAt, source }>` 元数据形态。**取舍**：当前阶段仅需字符串数组就能覆盖"勾选 + 手填"的全部诉求；显示用 `displayName` 的场景留待后续 capability。

### Decision 8b: InputBar 模型 dropdown 的渲染源头

跨 profile 模型快选 dropdown 改为只读两层数据：

- 每个 profile 渲染时取 `getProfileModels(profile, publicChannels): string[]`：
  - `builtin-edge` → `publicChannels[channelId].models.map(m => m.id)`
  - `user-byok` → `profile.models`
- 不再合并 `profileModelCache`（cache 仅在 Settings 中作为"候选池"使用，不污染 InputBar 列表）。

点击某条 option 时同时切换 `activeProfileId` 与目标 profile 的 `selectedModelId`，并在 BYOK 分支下持久化（builtin-edge 的 `selectedModelId` 也同样写回 profile，因为它就在 ClientProfile 里）。

### Decision 9: dev 环境下 builtin-edge 通过 Vite dev proxy 模拟边缘

`vite.config.ts` 增加一段 dev-only 中间件或代理：把 `/api-proxy/<channelId>/...` 转到本地 Node 实现，或直接调 Pages Functions 的本地模拟（`wrangler pages dev`）。**首选** `wrangler pages dev` 因为它能完整跑 `functions/` 目录与 secrets（通过 `.dev.vars`），与生产语义一致。`npm run dev` 调整为同时跑 Vite + `wrangler pages dev` 的脚本组合（或仅指引文档，按团队习惯定）。

## Risks / Trade-offs

- **[风险]** Pages Function cold start 增加首请求延迟 → 缓解：薄代理逻辑极短（<5ms），且后续请求复用 isolate；不引入额外冷启动可感知瓶颈。
- **[风险]** `channels.json` 中误把真 key 写进 `auth.secretRef`（字段名混淆） → 缓解：在 `build-public-channels.mjs` 中加 schema 校验，发现 `auth.secretRef` 形如 `sk-...` 立即报错退出。
- **[风险]** `allowedPaths` 漏配某个上游端点导致生产 404 → 缓解：Pages Function 在 path 拒绝时返回结构化错误 `{ error: 'path_not_allowed', channelId, path }`，便于排查。
- **[风险]** 删除 fal.ai 导致历史 TaskRecord 中 `falRequestId` 等字段成为孤儿 → 缓解：store hydrate 时同时 strip 这些字段；显示历史任务不依赖 fal 字段（输入/输出图都在 IndexedDB 里）。
- **[风险]** 用户在 BYOK 路径下错误配置导致 `/api-proxy/<channelId>` 形态的 URL（粘贴混了） → 缓解：客户端 dispatch 时按 `source` 严格分支，BYOK 永不走 `/api-proxy/`，channelId 校验失败立即提示。
- **[取舍]** `channels.json` 改动需要发版才能生效（无热更新） → 接受：channel 列表变化频率低；KV 化是后续 capability。
- **[取舍]** Pages Function 不做请求体校验（透传 JSON） → 接受：薄代理职责单一，校验留给上游；后续若做配额/审计再增厚。

## Migration Plan

1. **数据迁移**（一次性，store hydrate 阶段）：
   - 扫描 `settings.profiles`：
     - `provider === 'fal'` → 丢弃。
     - `id.startsWith('builtin-')` → 重写为 `{ source: 'builtin-edge', channelId: <匹配规则>, selectedModelId }`，丢弃 `apiKey`；若无法匹配到新 channels.json 中的任一 id → 丢弃并触发一次性 toast。
     - 其它（用户自建）→ 重写为 `{ source: 'user-byok', baseUrl, apiKey, models, selectedModelId, preferences: { apiMode, codexCli, apiProxy, responseFormatB64Json, timeout } }`，其中：
       - `models` 初始化为 `[...new Set([原 model, ...(原 models ?? [])].filter(Boolean))]`；若结果为空数组，注入 provider 默认模型（OpenAI → `gpt-image-2`，Gemini → `gemini-3.1-flash-image`）。
       - `selectedModelId` 取原 `model` 字段；若不在 `models` 中（理论不应出现，防御性兜底）则回退为 `models[0]`。
       - `providerDrafts` 字段在迁移时丢弃（其语义在新结构下由"切换 provider 时重置 models/selectedModelId 到该 provider 默认"覆盖；后续若需要可在 capability 中再加）。
   - `settings.builtinProfileModelSelections`（旧映射 `builtinProfileId → modelId`）在迁移完成后并入对应 builtin-edge profile 的 `selectedModelId`，原字段从 `AppSettings` 删除。
   - `activeProfileId` 若指向被丢弃的 profile → 回退到第一个可用 profile 或第一个 builtin。
   - `TaskRecord.falRequestId/falEndpoint/falRecoverable` 字段一律 delete。
2. **代码迁移**：按 `tasks.md` 顺序，先骨架（类型 + 构建脚本 + Pages Function）→ 再客户端 dispatch → 再 UI 双形态 → 最后删 fal。
3. **部署**：
   - 在 Cloudflare Pages dashboard 添加 secrets：`SUB2API_GEMINI_FLASH_KEY`、`SUB2API_GEMINI_FLASH_IMAGE_PREVIEW_KEY` 等（命名见 `channels.json`）。
   - `wrangler pages deploy` 自动包含 `functions/` 目录，无需额外配置。
4. **回滚**：保留 `feat/edge-channel-routing` 分支可恢复；若上线后发现严重问题，回滚 commit 即可（旧 builtin profile 的 localStorage 在新 schema 里被丢弃，回滚后用户需要重新配置自己的 BYOK；这是单向迁移，需在 release notes 提示）。

## Open Questions

- `channels.json` 是否要支持 `disabled: true` 字段以便临时下线某个 channel 而不删配置？（倾向加，零成本，留待 tasks 阶段确认。）
- BYOK profile 的 `preferences.apiProxy` 是否还有意义？（Docker/Nginx 部署形态下仍有用；Pages 部署形态下 BYOK 用户直连即可。**保留**，跨部署形态通用。）
- dev 环境是否强制 `wrangler pages dev` 还是给 fallback？（倾向：文档化首选 `wrangler pages dev`，同时在 `vite.config.ts` 加一段最小 dev proxy 把 `/api-proxy/*` 指向 `wrangler pages dev` 的端口，使 `npm run dev` 用户感无差异。tasks 中具体落地。）
- 切换 BYOK profile 的 `provider` 时如何处理 `models[]`？候选方案：(a) 全清空，强制用户重新勾选；(b) 保留原 `models[]`（允许跨 provider 模型混用，因为很多兼容端点支持任意名）；(c) 自动注入新 provider 的默认模型并保留原列表。**倾向 (c)**，最少惊喜，留待 tasks 阶段定。
- 是否要在 BYOK 多模型 UI 中显示每个模型的"上次使用时间"以便排序？（增强项，本次不做；记入未来 capability。）
