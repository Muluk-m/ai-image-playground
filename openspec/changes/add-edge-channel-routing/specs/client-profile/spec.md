## ADDED Requirements

### Requirement: ClientProfile dual-form schema

客户端 `ClientProfile` 类型 MUST 为可辨识联合，由 `source` 字段区分两种形态：

- `source: 'builtin-edge'`：字段集 `{ id, source, channelId, selectedModelId }`。MUST NOT 包含 `apiKey`、`baseUrl`、`apiMode`、`codexCli`、`apiProxy`、`responseFormatB64Json`、`timeout` 等运行时偏好——这些 SHALL 在使用时从对应 `PublicChannel.defaults` 读取。
- `source: 'user-byok'`：字段集 `{ id, source, name, kind, baseUrl, apiKey, models, selectedModelId, preferences }`，其中 `models: string[]` 为该 profile 下用户预存的模型 id 列表（用于 InputBar 现场切换），`selectedModelId: string` 必须在 `models` 中或为空字符串，`preferences: { apiMode, codexCli, apiProxy, responseFormatB64Json, timeout }`。

#### Scenario: 类型系统拒绝在 builtin-edge profile 上写入 apiKey

- **WHEN** 开发者尝试构造 `{ source: 'builtin-edge', id: 'x', channelId: 'y', selectedModelId: 'm', apiKey: 'sk-' }`
- **THEN** TypeScript 编译 SHALL 失败（`apiKey` 不在该联合分支字段集中）

#### Scenario: builtin-edge 运行时偏好从 channel 读取

- **WHEN** 客户端使用 `source: 'builtin-edge'` profile 发起请求
- **AND** 对应 `PublicChannel.defaults.apiMode === 'images'`
- **THEN** 请求 SHALL 使用 `apiMode='images'`
- **AND** UI SHALL NOT 渲染 apiMode 切换控件

### Requirement: BYOK multi-model store

`source: 'user-byok'` 形态的 profile MUST 在自身持有 `models: string[]`，用于驱动该 profile 下的模型快选；UI 编辑器 MUST 提供"添加模型"、"删除模型"两个动作，且 SHOULD 提供"从上游 `/v1/models` 拉取"动作以批量补全候选。`selectedModelId` MUST 等于 `models` 中的某一项，或在 `models` 为空时为空字符串。请求层 MUST 始终从 `selectedModelId` 读取本次请求的模型 id，不再读取已废弃的单字段 `model`。

#### Scenario: 添加模型后即可在 InputBar 中切换

- **WHEN** 用户在某 BYOK profile 编辑器中输入模型 id `gpt-image-2` 并点击"添加"
- **THEN** `profile.models` SHALL 包含 `gpt-image-2`
- **AND** 主界面 InputBar 的模型下拉 SHALL 在该 profile 激活时显示 `gpt-image-2`

#### Scenario: 删除当前选中模型后 selectedModelId 自动回退

- **WHEN** 用户删除的模型 id 等于 `selectedModelId`
- **THEN** `selectedModelId` SHALL 被设置为 `models[0]`（删除后的首项），若删除后 `models` 为空则为 `''`

#### Scenario: 从上游拉取模型列表

- **WHEN** 用户在 BYOK 编辑器点击"从 /v1/models 拉取"
- **AND** 上游响应正常返回模型列表
- **THEN** 客户端 SHALL 把返回的模型 id 合并进 `profile.models`（去重），不覆盖既有手工添加的项

#### Scenario: 旧 model: string 数据迁移

- **WHEN** localStorage 中旧 BYOK profile 含 `model: 'gpt-image-2'` 但无 `models`、无 `selectedModelId`
- **AND** 客户端启动 hydrate
- **THEN** 迁移后 profile SHALL 含 `models: ['gpt-image-2']`、`selectedModelId: 'gpt-image-2'`，且 `model` 字段被删除

### Requirement: Dispatch by profile source

`callImageApi` MUST 按 `profile.source` 严格分支：

- `'builtin-edge'` → 通过 `POST /api-proxy/<channelId>/<path>` 调用 Pages Function；MUST NOT 设置 `Authorization` header；MUST NOT 直连任何外部域名；path 由 `kind` 与请求类型（generate/edit）决定。
- `'user-byok'` → 沿用现有 `openaiCompatibleImageApi` / `geminiImageApi` adapter，自带 `Authorization`，按 `preferences.apiProxy` 决定走 `/api-proxy/` 同源代理（Nginx/Docker 形态）还是直连。

两条路径之间 MUST 无交叉：BYOK profile SHALL NEVER 发往 `/api-proxy/<channelId>/`；builtin-edge profile SHALL NEVER 直连外部域名。

#### Scenario: builtin-edge 请求不带 Authorization

- **WHEN** 客户端以 `source: 'builtin-edge'` profile 发起图像生成请求
- **THEN** 浏览器 DevTools 中该请求的 Request Headers SHALL NOT 包含 `Authorization`
- **AND** Request URL SHALL 形如 `/api-proxy/<channelId>/<path>`

#### Scenario: BYOK 请求带 Authorization 并直连或走同源代理

- **WHEN** 客户端以 `source: 'user-byok'` profile 发起请求且 `preferences.apiProxy: false`
- **THEN** 请求 URL SHALL 形如 `https://<baseUrl host>/<path>`，含 `Authorization: Bearer ${apiKey}`
- **AND** 当 `preferences.apiProxy: true` 时 URL SHALL 形如 `/api-proxy/<path>`（路径无 channelId），仍含 `Authorization`

### Requirement: Legacy profile migration on hydrate

Store hydrate（首次加载或版本升级）阶段 MUST 执行一次性迁移：

- `provider === 'fal'` 的任意 profile → 丢弃。
- `id.startsWith('builtin-')` 的 profile → 按规则映射 `channelId`（基于 id 后缀与 `config/channels.json` 中的 id），改写为 `source: 'builtin-edge'` 形态，丢弃 `apiKey` 及所有运行时偏好字段；若无法匹配到现存 channel → 丢弃。
- 其它 profile → 改写为 `source: 'user-byok'` 形态，原 `apiMode`、`codexCli`、`apiProxy`、`responseFormatB64Json`、`timeout` 合并入 `preferences`；原单字段 `model: string` 被升级为 `models: string[]` 与 `selectedModelId: string`：若旧 profile 同时存在 `models` 数组则去重合并并保留 `model` 作为 `selectedModelId`，否则 `models = [model]`、`selectedModelId = model`；旧字段 `model` 在迁移后删除。
- 旧 `builtinProfileModelSelections: Record<id, model>` 中的项 → 转写为对应 builtin-edge profile 的 `selectedModelId`，最终该字段 SHALL 从 `AppSettings` 中删除。
- `activeProfileId` 指向被丢弃 profile 时 → 回退到第一个 builtin-edge profile，若无则回退到第一个 user-byok profile。
- `TaskRecord.falRequestId`、`falEndpoint`、`falRecoverable` 字段 → 一律删除。

迁移 MUST 是幂等的，重复运行结果一致。

#### Scenario: fal profile 被丢弃

- **WHEN** localStorage 中存在 `{ provider: 'fal', apiKey: 'fal-...' }`
- **AND** 客户端启动 hydrate
- **THEN** 迁移后该 profile SHALL 不存在于 `settings.profiles[]`

#### Scenario: 旧 builtin profile 被改写

- **WHEN** localStorage 中存在 `{ id: 'builtin-sub2api-gemini', provider: 'gemini', apiKey: 'sk-...', model: 'gemini-3.1-flash-image', ... }`
- **AND** `config/channels.json` 中存在 id 为 `qlj-sub2api-gemini-flash-image` 的 channel（id 映射表已知）
- **THEN** 迁移后 profile SHALL 为 `{ id: '...', source: 'builtin-edge', channelId: 'qlj-sub2api-gemini-flash-image', selectedModelId: 'gemini-3.1-flash-image' }`
- **AND** 不再含 `apiKey`、`baseUrl`、`apiMode` 等字段

#### Scenario: 用户自建 profile 被保留

- **WHEN** localStorage 中存在用户自建 OpenAI profile `{ id: 'user-1', provider: 'openai', apiKey: 'sk-user', baseUrl: '...', apiMode: 'images', codexCli: true, ... }`
- **AND** 客户端启动 hydrate
- **THEN** 迁移后 profile SHALL 为 `{ id: 'user-1', source: 'user-byok', name, kind: 'openai-compat', baseUrl, apiKey: 'sk-user', selectedModelId: <原 model>, preferences: { apiMode: 'images', codexCli: true, apiProxy, responseFormatB64Json, timeout } }`

#### Scenario: TaskRecord 中 fal 字段被清理

- **WHEN** localStorage/IndexedDB 中 TaskRecord 含 `falRequestId: 'abc'`
- **AND** 客户端启动 hydrate
- **THEN** 该 TaskRecord SHALL 不再包含 `falRequestId`、`falEndpoint`、`falRecoverable` 键

### Requirement: UI form variation by profile source

设置面板的 profile 编辑器 MUST 按 `source` 渲染不同字段集：

- `'builtin-edge'`：仅允许编辑 `selectedModelId`（从 `PublicChannel.models` 选项中选）。`label`、`apiMode`、`timeout` 等以只读形式展示。MUST NOT 渲染 `apiKey`、`baseUrl`、`apiProxy` 输入控件。删除按钮可见。
- `'user-byok'`：渲染 `name`、`kind`、`baseUrl`、`apiKey`、`preferences.*` 字段；模型部分渲染**模型列表编辑器**（含已添加模型展示、"添加"输入框、"删除"按钮、"从 /v1/models 拉取"按钮），并提供 `selectedModelId` 单选。

#### Scenario: builtin-edge 编辑器不显示 apiKey 输入

- **WHEN** 用户在设置中点击编辑某个 `source: 'builtin-edge'` profile
- **THEN** 表单 SHALL NOT 包含 apiKey 输入框
- **AND** 表单 SHALL NOT 包含 apiProxy 切换开关
- **AND** 表单 SHALL 包含一个从 channel.models 派生的模型下拉框
