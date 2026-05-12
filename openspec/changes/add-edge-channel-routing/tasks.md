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

- [x] 3.1 新建 `src/lib/channels/types.ts`：定义 `ProviderKind`、`ChannelModel`、`ChannelDefaults`、`PublicChannel`、`ClientProfile`（discriminated union）；`ClientProfile (source='user-byok')` 形态包含 `models: string[]` 与 `selectedModelId: string`（**不再有单 `model` 字段**）；`ClientProfile (source='builtin-edge')` 仅 `channelId + selectedModelId`
- [x] 3.2 在 `src/types.ts` 中将 `AppSettings.profiles` 类型从 `ApiProfile[]` 改为 `ClientProfile[]`；删除 `AppSettings.builtinProfileModelSelections`（被并入 builtin-edge profile 的 `selectedModelId`）；保留 `ApiProfile` 类型为 deprecated（用于迁移函数签名）或直接删除并 inline 老形态
- [~] 3.3 ~~新建 `src/lib/channels/migration.ts`~~ — **已废弃**：项目尚无用户，不需要兼容旧数据；改为 hydrate 时直接丢弃无效 profile
- [~] 3.4 ~~BYOK 单 model → models[] 转换~~ — **已废弃**：直接以新 schema 启动，无需转换
- [~] 3.5 ~~builtin id 映射表~~ — **已废弃**：新 channels.json id 直接生效
- [x] 3.6 在 `src/store.ts` hydrate 阶段：对老 localStorage 数据按"丢弃不识别字段"策略加载，活配置缺失时回退到第一个可用 profile 或新建空 OpenAI BYOK
- [x] 3.7 新建 `src/lib/channels/profileSelectors.ts`：导出 `getProfileModels(profile, publicChannels): string[]`、`getSelectedModel(profile, publicChannels): string`、`updateProfileModels(profile, nextModels): ClientProfile`、`updateSelectedModel(profile, modelId): ClientProfile`，保证 `selectedModelId ∈ models` 不变量
- [~] 3.8 ~~编写 migration.test.ts~~ — **已废弃**：随 migration.ts 一并删除
- [x] 3.9 编写 `src/lib/channels/profileSelectors.test.ts`：覆盖两种 source 下的 getProfileModels / getSelectedModel；覆盖 updateProfileModels 删除当前 selectedModelId 时的回退

## 4. 删除旧 builtin 模式与相关清理

- [x] 4.1 删除 `src/lib/builtinProfiles.ts` 中 `DEFAULT_BUILTIN_PROFILES`、`VITE_BUILTIN_PROFILES` 解析逻辑、`parseBuiltinProfiles`、`getBuiltinProfiles`
- [x] 4.2 删除 `builtinProfiles.test.ts`
- [x] 4.3 删除 `.env.example` 中 `VITE_BUILTIN_PROFILES` 段落
- [x] 4.4 修改 `useDockerApiUrlMigrationNotice` 等钩子中对旧 builtin profile 的引用（若有）— 无引用，无需修改
- [x] 4.5 删除 `BUILTIN_PROFILE_ID_PREFIX` 常量；改用 `profile.source === 'builtin-edge'` 判断
- [x] 4.6 grep 残留清理（lib + UI 通过 toLegacyView / view shim 适配；运行时已无引用）

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

- [x] 6.1 重写 `src/lib/api.ts` 的 `callImageApi`：按 `profile.source` 分支；body 中 `model` 字段统一取自 `selectedModelId`
- [x] 6.2 新建 `src/lib/channels/edgeClient.ts`：构造 `/api-proxy/<channelId>/<path>` URL，按 `kind` 与 generate/edit 决定 path，fetch 不带 Authorization
- [x] 6.3 BYOK adapter 改用 `BYOKAdapterProfile`（imageApiShared.ts 新增）；callImageApi 把 `UserByokProfile` 拍平后下发
- [x] 6.4 `src/lib/devProxy.ts` 无需调整：builtin-edge 不经它，BYOK 侧 `shouldUseApiProxy` 读 `preferences.apiProxy`
- [x] 6.5 `getActiveApiProfile` 改为返回 `ClientProfile`；store 内通过 `toLegacyView` 兼容旧扁平消费点
- [x] 6.6 `src/lib/urlSettings.ts` 中 `?model=` 写入新 profile 的 `selectedModelId`（同时进 `models[]`）；builtin-edge 校验留待 UI 改造时处理
- [x] 6.7 `src/lib/api.test.ts` 覆盖 BYOK 路径 + apiProxy / Authorization；builtin-edge 路径由 `functions/_lib/handler.test.ts` 直接覆盖（无需 mock）

## 7. UI 双形态

- [x] 7.1 `SettingsModal.tsx` 通过 DraftSettings + apiProfileToClientProfile shim 桥接（builtin-edge 分支保留只读语义）
- [x] 7.2 user-byok 表单字段映射到 `preferences.*`（model 字段仍为单输入框；多模型 chip 编辑器留待后续 UX 改造）
- [~] 7.2a 提取 `BYOKModelListEditor.tsx` 组件 — **本次未做**：留待后续 UX 改造，单输入框 + selectedModelId 不变量已由 shim 维持
- [x] 7.3 profile 列表渲染：builtin-edge 通过本地 isBuiltinProfile shim 显示「内置」徽章
- [x] 7.4 新建 profile 按钮：仅允许创建 user-byok
- [x] 7.5 `InputBar.tsx` 通过 profileView() helper 驱动模型下拉与选中态；切换模型时同步 selectedModelId
- [x] 7.5a `ModelCombobox.tsx` 通过 view 层读 selectedModelId；下拉项来源由 profileView 提供
- [x] 7.5b `urlSettings.ts`：URL `?model=` 写入新 user-byok 的 selectedModelId（并加入 models[]）
- [x] 7.6 `Header.tsx` / `TaskCard.tsx` 通过统一 view helper 取 name / selectedModelId；TaskRecord.apiModel 写入时取 selectedModelId
- [x] 7.7 删除 `apiProxy` 切换开关在 builtin-edge 表单中的渲染分支
- [ ] 7.8 端到端手测：切到 builtin profile 生成一张图，验证 DevTools 中无 Authorization header；切到 BYOK profile 生成一张图，验证仍带 Authorization

## 8. 开发环境与部署

- [ ] 8.1 在 `package.json` `scripts.dev` 旁新增 `scripts.dev:edge` 调用 `wrangler pages dev . --port 8788 --binding ...`（或类似），文档中说明同时运行 vite 与 pages dev
- [ ] 8.2 在 `vite.config.ts` 加 dev proxy：把 `/api-proxy/<channelId>/*` 代理到 `http://localhost:8788`，让 `npm run dev` 用户感无差异
- [ ] 8.3 在仓库根新增 `.dev.vars.example`：列出 `SUB2API_GEMINI_FLASH_KEY=` 等 secret 占位
- [ ] 8.4 README：删除 fal 段落；新增「内置 channel 工作流」章节（改 channels.json + 加 Pages secret + 部署）；新增「BYOK vs 内置」对比段
- [ ] 8.5 `wrangler.jsonc` 检查：assets-only 配置无需改动；如需 Pages Functions 显式开关则补 `pages_build_output_dir` 等字段
- [ ] 8.6 Cloudflare Pages dashboard 同步：在 production 与 preview 环境分别添加 channels.json 中所有 secretRef 对应的环境变量

## 9. 验收与归档

- [x] 9.1 `pnpm test` 全部通过（15 文件 / 158 用例）
- [x] 9.2 `tsc -b` 通过（vite build 待手动确认）
- [ ] 9.3 Pages preview 部署验证：内置 profile 出图正常；DevTools 无 Authorization；secret 未配置时返回 500
- [ ] 9.4 BYOK profile 在 preview 上验证：直连与 apiProxy 两条路径均可出图
- [ ] 9.5 在生产环境分别用 Chrome 与 Safari 验证一次
- [ ] 9.6 运行 `openspec validate add-edge-channel-routing --strict`，确认通过
- [ ] 9.7 合并 PR 后运行 `/opsx:apply` 收尾或 `openspec archive` 归档变更
