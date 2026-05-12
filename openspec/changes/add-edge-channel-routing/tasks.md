## 0. 切换包管理器到 pnpm

- [x] 0.1 删除 `package-lock.json`
- [x] 0.2 修改 `.github/workflows/deploy.yml`：增加 `pnpm/action-setup`，将 `npm ci` 改为 `pnpm install --frozen-lockfile`、`npm run build` 改为 `pnpm build`，并把 `setup-node` 的 `cache` 改为 `pnpm`
- [x] 0.3 修改 `deploy/Dockerfile`：安装 pnpm 后用 `pnpm install --frozen-lockfile` / `pnpm build`
- [x] 0.4 修改 `README.md` 中所有 `npm install` / `npm run` / `npm ci` 引用为 `pnpm` 等价形式
- [x] 0.5 执行 `pnpm install` 生成 `pnpm-lock.yaml` 并提交

## 1. 移除 fal.ai 支持

- [x] 1.1 删除 `src/lib/falAiImageApi.ts` 与 `falAiImageApi.test.ts`
- [x] 1.2 在 `src/types.ts` 中：从 `BuiltInApiProvider` 移除 `'fal'`；从 `TaskRecord` 删除 `falRequestId` / `falEndpoint` / `falRecoverable` 字段
- [x] 1.3 在 `src/lib/api.ts` 中删除 `provider === 'fal'` 分支
- [x] 1.4 在 `src/lib/apiProfiles.ts` 中删除 `DEFAULT_FAL_BASE_URL` / `DEFAULT_FAL_MODEL` 常量与 fal 相关 `providerDrafts` 默认
- [x] 1.5 在 `src/lib/providerModels.ts` 中删除 `fal: [...]` 条目
- [x] 1.6 `package.json` 移除 `@fal-ai/client` 依赖并执行 `pnpm install`
- [x] 1.7 grep 全仓库确保无 `fal` / `falAi` 残留引用（README、UI 文案、测试）
- [x] 1.8 运行 `pnpm test` 与 `tsc -b` 确认无类型错误
- [x] 1.x `src/lib/paramCompatibility.ts` 移除 fal 分支与 `DEFAULT_FAL_IMAGE_SIZE` / `MAX_FAL_OUTPUT_IMAGES`（不在原 tasks 中但属 Section 1 范围）
- [x] 1.y `src/lib/fetchProfileModels.ts` 与 test 移除 fal 拒绝逻辑（不在原 tasks 中但属 Section 1 范围）

## 2. Channel 配置真源与构建产物

- [x] 2.1 新建 `config/channels.json`，按 design.md 中两个示例填入初始 channel（OpenAI、sub2api Gemini Flash Image）
- [x] 2.2 新建 `scripts/build-public-channels.mjs`：读取 `config/channels.json`，校验必填字段、id 唯一、`auth.secretRef` 不形如真密钥，输出 `src/generated/channels.public.json`（仅含 `id/kind/label/models/defaults/disabled`）
- [x] 2.3 校验失败时 `process.exit(1)` 并打印定位信息
- [x] 2.4 `package.json` 中 `scripts.build` 改为 `node scripts/build-public-channels.mjs && tsc -b && vite build`；新增 `scripts.gen:channels` 单独命令
- [x] 2.5 将 `src/generated/` 加入 `.gitignore`（产物不进 git）
- [x] 2.6 编写 `scripts/build-public-channels.test.mjs` 或 vitest 用例，覆盖：缺字段、id 重复、secretRef 形如真密钥、正常派生 4 个场景
- [x] 2.7 新建 `src/lib/channels/publicChannels.ts`：`import publicChannelsJson from '../../generated/channels.public.json'`，导出 `getPublicChannels()` / `getPublicChannel(id)`，过滤 `disabled: true`

## 3. 客户端类型与 Profile 重构

- [ ] 3.1 新建 `src/lib/channels/types.ts`：定义 `ProviderKind`、`ChannelModel`、`ChannelDefaults`、`PublicChannel`、`ClientProfile`（discriminated union）；`ClientProfile (source='user-byok')` 形态包含 `models: string[]` 与 `selectedModelId: string`（**不再有单 `model` 字段**）；`ClientProfile (source='builtin-edge')` 仅 `channelId + selectedModelId`
- [ ] 3.2 在 `src/types.ts` 中将 `AppSettings.profiles` 类型从 `ApiProfile[]` 改为 `ClientProfile[]`；删除 `AppSettings.builtinProfileModelSelections`（被并入 builtin-edge profile 的 `selectedModelId`）；保留 `ApiProfile` 类型为 deprecated（用于迁移函数签名）或直接删除并 inline 老形态
- [ ] 3.3 新建 `src/lib/channels/migration.ts`：实现 `migrateLegacyProfiles(rawSettings)`，覆盖 fal 丢弃、builtin → builtin-edge、其它 → user-byok、activeProfileId 回退、TaskRecord 字段清理、`builtinProfileModelSelections` 并入 builtin-edge profile；幂等
- [ ] 3.4 在 migration.ts 中实现 BYOK 单 model → models[] + selectedModelId 转换：`models = uniq([model, ...(legacy.models ?? [])].filter(Boolean))`，空时按 provider 注入默认（OpenAI → `gpt-image-2`，Gemini → `gemini-3.1-flash-image`）；`selectedModelId = legacy.model ?? models[0]`
- [ ] 3.5 准备 builtin id 映射表（旧 `builtin-sub2api-gemini` → 新 `qlj-sub2api-gemini-flash-image` 等），随 `channels.json` 一同维护，放在 migration.ts 顶部
- [ ] 3.6 在 `src/store.ts` hydrate 阶段调用 migration，未识别 profile 触发一次性 toast
- [ ] 3.7 新建 `src/lib/channels/profileSelectors.ts`：导出 `getProfileModels(profile, publicChannels): string[]`、`getSelectedModel(profile, publicChannels): string`、`updateProfileModels(profile, nextModels): ClientProfile`、`updateSelectedModel(profile, modelId): ClientProfile`，保证 `selectedModelId ∈ models` 不变量
- [ ] 3.8 编写 `src/lib/channels/migration.test.ts`：覆盖每个迁移分支与幂等性，含 BYOK 多模型迁移（含 model 已在 models 中、不在、为空、provider 默认注入四种场景）
- [ ] 3.9 编写 `src/lib/channels/profileSelectors.test.ts`：覆盖两种 source 下的 getProfileModels / getSelectedModel；覆盖 updateProfileModels 删除当前 selectedModelId 时的回退

## 4. 删除旧 builtin 模式与相关清理

- [ ] 4.1 删除 `src/lib/builtinProfiles.ts` 中 `DEFAULT_BUILTIN_PROFILES`、`VITE_BUILTIN_PROFILES` 解析逻辑、`parseBuiltinProfiles`、`getBuiltinProfiles`
- [ ] 4.2 删除 `builtinProfiles.test.ts`
- [ ] 4.3 删除 `.env.example` 中 `VITE_BUILTIN_PROFILES` 段落
- [ ] 4.4 修改 `useDockerApiUrlMigrationNotice` 等钩子中对旧 builtin profile 的引用（若有）
- [ ] 4.5 `BUILTIN_PROFILE_ID_PREFIX` 常量保留意义重定义：用作"builtin-edge profile id"前缀，等于 channelId（即 `qlj-` 之类）；或直接删除该常量，让 source 判断取代前缀判断
- [ ] 4.6 grep 残留：`isBuiltinProfile`、`builtinProfileModelSelections`、`builtin-` 字面量

## 5. Pages Function 实现

- [x] 5.1 新建 `functions/_lib/channels.ts`：`import channels from '../../config/channels.json' assert { type: 'json' }`（或通过 `wrangler.toml` 的 [vars] 注入），导出 `findChannel(id)`
- [x] 5.2 新建 `functions/_lib/adapters/openaiCompat.ts`：bearer 注入函数 _(整合进 handler.ts，未拆独立文件)_
- [x] 5.3 新建 `functions/_lib/adapters/gemini.ts`：query-key 或 header 注入函数 _(同上)_
- [x] 5.4 新建 `functions/api-proxy/[channelId]/[[path]].ts`：实现路由（POST/GET/OPTIONS）、channelId 查表、disabled 校验、path 严格白名单、CORS、超时、流式 fetch、错误结构化返回
- [x] 5.5 实现 OPTIONS 预检 handler，返回 CORS headers
- [x] 5.6 实现密钥未配置时的 500 结构化错误
- [x] 5.7 实现 `kind: 'http-template'` 的 501 占位响应
- [x] 5.8 编写 Pages Function 集成测试（覆盖：成功转发、channel 不存在 404、path 不允许 403、disabled 503、缺 secret 500、超时 504、Authorization 剥除、OPTIONS CORS、query-key 注入；通过 fetch 注入测试，无需 miniflare）

## 6. 客户端 dispatch 与请求路径

- [ ] 6.1 重写 `src/lib/api.ts` 的 `callImageApi`：按 `profile.source` 分支；请求 body 中的 `model` 字段统一改读 `getSelectedModel(profile, publicChannels)`
- [ ] 6.2 新建 `src/lib/channels/edgeClient.ts`：构造 `/api-proxy/<channelId>/<path>` URL，按 `kind` 与 generate/edit 决定 path（`images/generations` / `images/edits` / `responses` 或 Gemini path），发起 fetch 时不带 Authorization
- [ ] 6.3 `src/lib/openaiCompatibleImageApi.ts` 与 `geminiImageApi.ts` 改为只服务 BYOK 路径，从入参接收完整 `ClientProfile (source='user-byok')`，body 中 model 字段读 `profile.selectedModelId`
- [ ] 6.4 `src/lib/devProxy.ts` 中 `buildApiUrl` / `shouldUseApiProxy` 重新审视，确保 BYOK 同源代理与 builtin-edge 不互相干扰
- [ ] 6.5 更新或删除 `apiProfiles.ts` 中 `getActiveApiProfile` 等函数签名以返回 `ClientProfile`
- [ ] 6.6 `src/lib/urlSettings.ts` 中 `?model=` 参数解析改为：写入 active profile 的 `selectedModelId`；BYOK 时若 model 不在 `profile.models[]` 自动追加，builtin-edge 时若不在 `channel.models` 中则提示并忽略
- [ ] 6.7 编写 `src/lib/api.test.ts` 覆盖两种 source 的 URL/header 形态断言、body 中 model 字段取自 `selectedModelId`

## 7. UI 双形态

- [ ] 7.1 `SettingsModal.tsx` 中 profile 编辑器按 `source` 分支：builtin-edge 表单仅显示 channel label（只读）、模型下拉（来自 channel.models）、删除按钮
- [ ] 7.2 user-byok 表单沿用现有控件，字段名映射到 `preferences.*`；模型字段从单输入框替换为"模型列表编辑器"组件：已添加模型 chip 列表（每项带删除按钮）+ 输入框 + "添加"按钮 + "从 /v1/models 拉取"按钮（pull 完成后合并去重）；`selectedModelId` 单选保留在编辑器旁
- [ ] 7.2a 提取 `BYOKModelListEditor.tsx` 组件，复用 `profileSelectors.ts` 中的 helpers，确保 selectedModelId ∈ models 不变量
- [ ] 7.3 profile 列表渲染：builtin-edge 显示「内置」徽章（沿用现有样式）；user-byok 正常显示
- [ ] 7.4 新建 profile 按钮：仅允许创建 user-byok（builtin 只能由 channels.json 增删）
- [ ] 7.5 `InputBar.tsx` 模型下拉：builtin-edge profile 的模型来源改为 `PublicChannel.models`；user-byok 来源改为 `profile.models[]`；统一通过 `getProfileModels(profile, publicChannels)` 取值；选中态由 `selectedModelId` 驱动；切换模型的 store action 同时更新 `selectedModelId`
- [ ] 7.5a `ModelCombobox.tsx` 调整：去掉对单字段 `model` 的依赖，改读 `selectedModelId`；下拉项来源统一为 `getProfileModels` 返回值
- [ ] 7.5b `urlSettings.ts`：URL 参数 `?model=` 解析时改为写入 `selectedModelId`（并在不存在于 `models` 时自动 push 进 `models`）；导出/导入 settings 时去掉单 `model` 字段
- [ ] 7.6 `Header.tsx` / `TaskCard.tsx` 中"profile name"、"model tag"展示无需感知 source，通过统一 helper `getProfileDisplayName(profile, publicChannels)` / `getSelectedModel(profile, publicChannels)` 取值；TaskRecord.apiModel 写入时取 `selectedModelId` 而非旧 `profile.model`
- [ ] 7.7 删除 `apiProxy` 切换开关在 builtin-edge 表单中的渲染分支
- [ ] 7.8 端到端手测：切到 builtin profile 生成一张图，验证 DevTools 中无 Authorization header；切到 BYOK profile 生成一张图，验证仍带 Authorization

## 8. 开发环境与部署

- [ ] 8.1 在 `package.json` `scripts.dev` 旁新增 `scripts.dev:edge` 调用 `wrangler pages dev . --port 8788 --binding ...`（或类似），文档中说明同时运行 vite 与 pages dev
- [ ] 8.2 在 `vite.config.ts` 加 dev proxy：把 `/api-proxy/<channelId>/*` 代理到 `http://localhost:8788`，让 `npm run dev` 用户感无差异
- [ ] 8.3 在仓库根新增 `.dev.vars.example`：列出 `SUB2API_GEMINI_FLASH_KEY=` 等 secret 占位
- [ ] 8.4 README：删除 fal 段落；新增「内置 channel 工作流」章节（改 channels.json + 加 Pages secret + 部署）；新增「BYOK vs 内置」对比段
- [ ] 8.5 `wrangler.jsonc` 检查：assets-only 配置无需改动；如需 Pages Functions 显式开关则补 `pages_build_output_dir` 等字段
- [ ] 8.6 Cloudflare Pages dashboard 同步：在 production 与 preview 环境分别添加 channels.json 中所有 secretRef 对应的环境变量

## 9. 验收与归档

- [ ] 9.1 `pnpm test` 全部通过
- [ ] 9.2 `tsc -b` 与 `vite build` 全部通过
- [ ] 9.3 Pages preview 部署验证：内置 profile 出图正常；DevTools 无 Authorization；secret 未配置时返回 500
- [ ] 9.4 BYOK profile 在 preview 上验证：直连与 apiProxy 两条路径均可出图
- [ ] 9.5 在生产环境分别用 Chrome 与 Safari 验证一次
- [ ] 9.6 运行 `openspec validate add-edge-channel-routing --strict`，确认通过
- [ ] 9.7 合并 PR 后运行 `/opsx:apply` 收尾或 `openspec archive` 归档变更
