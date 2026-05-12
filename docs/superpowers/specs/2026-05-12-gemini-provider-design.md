# Gemini 服务商集成 + 内置 Profile 设计

**日期**：2026-05-12
**目标**：
1. 在 gpt-image-playground 中新增内建 Gemini 服务商，支持通过 Google Gemini 原生 `v1beta/generateContent` 接口调用 `gemini-3.1-flash-image` 等图像生成模型。
2. 引入「内置 Profile」机制：一组在代码 / 部署期注入的预填 ApiProfile（含 baseUrl、apiKey、model），在 Profile 列表顶部以「内置」标签展示，只读、不可编辑、不可删除，且不会被持久化覆盖。

保持现有 OpenAI / fal.ai / 自定义服务商行为不变。

---

## 1. 背景

现项目提供三类服务商：

- 内建 `openai`：OpenAI 兼容（含 `Images API` / `Responses API` / Codex CLI 模式）
- 内建 `fal`：fal.ai 队列服务
- 自定义 `http-image`：基于 JSON manifest 的 OpenAI 兼容形态扩展（仅描述 `data[].b64_json|url` 形态）

用户希望调用通过 sub2api 网关或 Google 官方提供的 Gemini 图像模型（如 `gemini-3.1-flash-image`、`gemini-3.1-pro-preview`）。Gemini 原生协议（`v1beta/models/{model}:generateContent`）的请求/响应结构与 OpenAI 差异显著（嵌套 `contents[].parts[]`、响应在 `candidates[].content.parts[].inlineData`），现有 `http-image` 模板无法覆盖。

## 2. 设计目标 / 非目标

**目标**

- 新增内建 `gemini` provider，按 Google 原生 `v1beta` 协议调用图像生成
- 支持文本生图 + 多张参考图输入（inlineData）
- 与现有 provider 切换、配置导入导出、历史任务回放保持兼容
- 错误信息复用现有 `getApiErrorMessage` 解析
- 引入「内置 Profile」：用户在 Profile 列表顶部看到带「内置」徽章的只读 profile，可激活使用但不可编辑/删除；其内容由代码常量或部署时环境变量提供

**非目标**

- Streaming / thinking budget / safetySettings 等高级 generationConfig
- Files API (`files.upload`)：参考图直接走 base64 inlineData
- 遮罩编辑（Gemini API 不支持，明确拒绝）
- 改造 `http-image` 模板 DSL 兼容 Gemini 形态（成本高于新增独立 provider）
- 改造 UI 品牌 / 名称 / 默认配置
- 内置 Profile 的加密 / 混淆：apiKey 会进 bundle，公开部署可被读取，使用方自负

## 3. 关键决策

**决策一：用独立 `gemini` 内建 provider，不走 `http-image` 模板**

权衡：
- 选项 A（用 `http-image` 模板）需扩展模板 DSL，引入「parts 形态请求体」「`candidates` 路径解析」等新概念，影响面广、对其它 OpenAI 兼容自定义服务商引入额外复杂度
- 选项 B（独立 provider）与 `falAiImageApi.ts` 同构，隔离干净

选 B。

**决策二：默认 baseUrl 用 Google 官方**

`https://generativelanguage.googleapis.com/v1beta`。保持上游中立，社区其它使用者 fork 后无需改默认值即可用 Google AI Studio 的 Key。用户自己的 sub2api 网关只需在配置界面修改 baseUrl。

**决策三：Gemini 选中时隐藏不支持的 UI 参数**

`mask` 按钮禁用并 tooltip 提示「当前服务商不支持」；`quality`、`output_format`、`output_compression`、`moderation` 控件在 Gemini profile 激活时隐藏。`size` 控件保留（用于推断 aspectRatio），`n` 保留。

**决策四：内置 Profile 通过「编译期常量 + 运行时合并」实现，不进持久化**

- 配置源：`src/lib/builtinProfiles.ts` 导出 `BUILTIN_PROFILES: ApiProfile[]`，默认空数组；同时支持 `import.meta.env.VITE_BUILTIN_PROFILES`（JSON 字符串）覆盖，便于部署期注入而不污染仓库
- 标识：每个内置 profile id 以 `builtin-` 前缀命名（如 `builtin-gemini-flash`），运行时通过前缀判断是否只读
- 不持久化：写入 `localStorage` 前从 `profiles` 中剔除 `builtin-*`，启动时重新注入到列表顶部；用户的 `activeProfileId` 可以引用 `builtin-*`（解析时优先查内置列表）
- 用户在内置 profile 上点「编辑」时弹出「该 Profile 为内置，请使用『复制为新配置』」提示，提供一键复制为可编辑 profile 的快捷入口

## 4. 改动范围

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `BuiltInApiProvider = 'openai' \| 'fal' \| 'gemini'` |
| `src/lib/apiProfiles.ts` | 新增 `DEFAULT_GEMINI_BASE_URL='https://generativelanguage.googleapis.com/v1beta'`、`DEFAULT_GEMINI_MODEL='gemini-3.1-flash-image'`、`createDefaultGeminiProfile`；扩展 `BUILT_IN_PROVIDER_IDS`、`switchApiProfileProvider`、`normalizeApiProfile`、`normalizeProviderDraft`、`getApiProviderLabel`、`validateApiProfile`；新增 `BUILTIN_PROFILE_ID_PREFIX`、`isBuiltinProfile(profile)` |
| `src/lib/builtinProfiles.ts` **(新)** | `BUILTIN_PROFILES: ApiProfile[]`：从 `VITE_BUILTIN_PROFILES` env JSON 读取（失败/空则回退到模块内常量数组，默认 `[]`）。模块只导出值，不依赖 React/store |
| `src/lib/geminiImageApi.ts` **(新)** | `callGeminiImageApi(opts, profile): Promise<CallApiResult>` |
| `src/lib/api.ts` | `if (profile.provider === 'gemini') return callGeminiImageApi(opts, profile)` |
| `src/store.ts` | `normalizeSettings` 调用处把 `BUILTIN_PROFILES` 注入到 `profiles` 顶部；持久化写入前用 `stripBuiltinProfiles` 过滤；启动时若 `activeProfileId` 不存在则保持指向（解析时回退到第一个内置/用户 profile） |
| `src/components/SettingsModal.tsx` | provider 下拉新增 `Gemini`；`defaultProviderOrder` 加入 `'gemini'`；Profile 列表项渲染时如 `isBuiltinProfile` 则显示「内置」徽章、隐藏删除按钮、表单字段 readonly；提供「复制为新配置」按钮 |
| `src/components/InputBar.tsx` 等 | gemini 激活时隐藏 quality/output_format/output_compression/moderation 控件、禁用 mask 按钮（具体落点在实现期再定，原则：在控件渲染处增加 `provider === 'gemini'` guard） |
| `src/lib/geminiImageApi.test.ts` **(新)** | 单元测试：请求体构造、响应解析、参数映射、mask 拒绝 |
| `src/lib/builtinProfiles.test.ts` **(新)** | env JSON 解析、空值回退、id 强制前缀校验 |
| `src/lib/apiProfiles.test.ts` | 补 gemini 切换 / normalize 用例、`isBuiltinProfile` 判定 |
| `.env.example` **(新或更新)** | 加 `VITE_BUILTIN_PROFILES` 注释和示例 |

## 5. Gemini 请求 / 响应映射

### 5.1 请求

端点：`POST {baseUrl}/models/{model}:generateContent`

Header：
```
Content-Type: application/json
x-goog-api-key: <profile.apiKey>
```

Body：
```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "<prompt>" },
      { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "aspectRatio": "1:1" },
    "candidateCount": 1
  }
}
```

### 5.2 参数映射

| TaskParams 字段 | 处理 |
|---|---|
| `prompt` | `contents[0].parts[0].text` |
| `inputImageDataUrls` | 每个 data URL 拆解为 `{mimeType, data}` 后追加到 `contents[0].parts[]` |
| `maskDataUrl` | **抛错**：`new Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 或 fal.ai 服务商')` |
| `params.size` | 解析 `"WxH"` 算出 `W/H`，与候选集 {`1:1`=1.0, `16:9`≈1.778, `9:16`≈0.563, `4:3`≈1.333, `3:4`=0.75} 中比值绝对差最小的一项作为 `aspectRatio`；`"auto"` 或解析失败时省略 `imageConfig` |
| `params.n` | `candidateCount`；范围 1–4 |
| `params.quality` | 忽略（UI 已隐藏） |
| `params.output_format` | 忽略；输出图片的 `mimeType` 以响应为准 |
| `params.output_compression` | 忽略 |
| `params.moderation` | 忽略 |

### 5.3 响应

```jsonc
{
  "candidates": [{
    "content": {
      "parts": [
        { "text": "..." },                                   // 可选文字解释
        { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
      ]
    },
    "finishReason": "STOP"
  }]
}
```

解析：
1. 遍历 `candidates[].content.parts[]`
2. 对每个 `inlineData`，取 `mimeType` + `data`，组装 `data:{mimeType};base64,{data}` 加入 `images[]`
3. 文字 `parts[].text` 作为 `revisedPrompts`（每张图取自同 candidate 的 text；无则 undefined）
4. `actualParamsList`：未知尺寸由 `readImageSizeParamsList`（store 中已有）补齐，本函数返回 `undefined`

错误：直接 `await response.json()` 后用现有 `getApiErrorMessage`。Gemini 错误形如 `{ "error": { "code": 400, "message": "...", "status": "INVALID_ARGUMENT" } }`，`error.message` 字段已经被 `getApiErrorMessage` 支持。

### 5.4 candidateCount 兜底

部分 Gemini 后端实现可能拒绝 `candidateCount > 1` 并返回 400。**第一版不做并发兜底**，让用户看到原始错误并自行降到 n=1。后续如发现 sub2api / 官方差异再补回退逻辑。

## 6. UI 与配置

### 6.1 默认值

`createDefaultGeminiProfile`：
- `id`: `gemini-${ts}-${rand}`
- `name`: `'新配置'`
- `provider`: `'gemini'`
- `baseUrl`: `'https://generativelanguage.googleapis.com/v1beta'`
- `apiKey`: `''`
- `model`: `'gemini-3.1-flash-image'`
- `timeout`: `DEFAULT_API_TIMEOUT`
- `apiMode`: `'images'`（不使用，仅占位）
- `codexCli`: `false`
- `apiProxy`: `false`

### 6.2 设置面板

`providerSelectOptions` 中插入 `{ label: 'Gemini', value: 'gemini', draggable: true }`，紧邻 `fal.ai` 之后。`defaultProviderOrder` 改为 `['openai', 'fal', 'gemini', ...customProviders]`。

切换 provider 到 gemini 时：
- 在 `switchApiProfileProvider` 增加 `gemini` 分支：与 `fal` 分支结构对称，但 `baseUrl` 默认 `DEFAULT_GEMINI_BASE_URL`、`model` 默认 `DEFAULT_GEMINI_MODEL`、强制 `codexCli=false`、`apiProxy=false`
- `apiMode` 始终 `'images'`（虽然不用，保持类型一致）

激活 gemini profile 时：
- 隐藏：`Codex CLI 兼容` 开关、`同源代理` 开关、`返回 Base64` 开关、`API 模式 (images/responses)` 切换
- 显示：baseUrl、apiKey、model、timeout

### 6.3 InputBar / 参数面板

`provider === 'gemini'` 时：
- 隐藏 `quality` / `output_format` / `output_compression` / `moderation` 控件
- `mask` 按钮置灰，hover tooltip：「当前服务商不支持遮罩编辑」
- `size` 选择器照常显示，但 `actualParams` 仅显示 size

DetailModal 中显示「实际生效参数」时，对 gemini 任务只展示 `size` + `n`。

### 6.4 内置 Profile UI

**列表项**（`SettingsModal` 中 profile 列表）：

```
┌─ Profile 列表 ─────────────────────────┐
│ 🔒 内置 · Gemini Flash Image  [复制]   │  ← 内置项，灰底/特殊角标
│ 🔒 内置 · Gemini 3 Pro Preview  [复制] │
│ ─────────────────────────────────────  │
│ 📝 我的 OpenAI               [编 ⋮]    │  ← 用户 profile，保持原交互
│ 📝 fal.ai 默认                [编 ⋮]    │
└────────────────────────────────────────┘
```

- 内置项徽章：复用 `Header.tsx` 风格的小标签，文案「内置」
- 内置项无「⋮ 删除」菜单
- 内置项点击「编辑」/双击：弹 Toast「该 Profile 为内置，已为你复制为新配置」，自动调用「复制为新配置」逻辑并切到新 profile（无破坏性）
- 内置项可被激活（点选）；激活后所有字段在编辑面板里 readonly，只显示信息

**默认激活**：

- 首次启动且 `BUILTIN_PROFILES.length > 0`：`activeProfileId` 取第一个内置 profile id
- 升级 / 已有用户：保持原 `activeProfileId`，不强制切换

**复制为新配置**：

- 生成新 `id`：`${profile.provider}-${ts}-${rand}`
- 复制全部字段（含 apiKey）
- 名称：`"<原名称> 副本"`
- 添加到 `profiles` 列表，立即切换为 active

## 7. 数据流

`store.submitTask` → `callImageApi(opts)` → `api.ts` 按 `profile.provider` 分发：

```
profile.provider:
  'fal'    -> callFalAiImageApi
  'gemini' -> callGeminiImageApi   ← 新增
  其它     -> callOpenAICompatibleImageApi
```

`TaskRecord.apiProvider` 写入 `'gemini'`；恢复任务时同样走 gemini 分支。`getFalRecoveryProfile` / `getCustomTaskRecoveryProfile` 不受影响（gemini 同步返回，无任务恢复需求）。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| `maskDataUrl` 非空 | 同步抛 `Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 或 fal.ai 服务商')` |
| HTTP 非 2xx | `getApiErrorMessage(response)` → `throw new Error(msg)` |
| 响应缺 `candidates` 或无 `inlineData` | `throw new Error('Gemini 未返回可用图片数据')` 并附 `rawResponsePayload` |
| 网络/超时 | 复用 `fetch` 的 `AbortController` 模式（同 OpenAI 兼容） |
| API Key 缺失 | `validateApiProfile` 已校验 |

## 9. 测试

**`src/lib/geminiImageApi.test.ts`**（vitest，仿照现有 `falAiImageApi.test.ts` / `openaiCompatibleImageApi` 测试形态）：

- `buildGeminiRequestBody`：纯文本 prompt → 正确 parts
- `buildGeminiRequestBody`：prompt + 2 张参考图 → 3 个 parts
- `buildGeminiRequestBody`：`size='1024x1024'` → `aspectRatio: '1:1'`；`size='1536x1024'`（比值 1.5）→ `'4:3'`（最近候选 1.333，差 0.167，优于 `16:9` 差 0.278）
- `buildGeminiRequestBody`：`size='auto'` → 不带 `imageConfig`
- `buildGeminiRequestBody`：`n=3` → `candidateCount: 3`
- `parseGeminiResponse`：单 candidate 单 inlineData → 1 张图
- `parseGeminiResponse`：单 candidate 多 inlineData → 多张图
- `parseGeminiResponse`：text + inlineData → 图片 + revisedPrompt
- `parseGeminiResponse`：空 candidates → throw
- `callGeminiImageApi`：传入 mask → throw `不支持遮罩`
- `callGeminiImageApi`：mock fetch 返回 400 + `error.message` → throw 带消息

**`src/lib/apiProfiles.test.ts`** 补充：

- `switchApiProfileProvider`：openai → gemini → fal → gemini，保留 providerDrafts
- `normalizeApiProfile`：`provider: 'gemini'` 输入正常 round-trip
- `getApiProviderLabel`：`'gemini' → 'Gemini'`

## 10. 兼容性 / 迁移

- 旧设置（无 `gemini` profile）：`normalizeSettings` 无需迁移，因 `profiles` 不强制包含 gemini
- 历史任务 `apiProvider` 为 `'openai'` / `'fal'` / `'custom-*'` 不受影响
- 设置导出 JSON 中 gemini profile 与现有 profile 同构，导入时通过 `normalizeApiProfile` 接受 `'gemini'`
- `providerOrder` 若存量没有 `'gemini'`，`SettingsModal` 渲染时按 `defaultProviderOrder` 末尾追加（已有逻辑）

### 10.1 内置 Profile 迁移要点

- 持久化兼容：升级前用户的 `profiles` 列表不含 `builtin-*`；升级后启动时 `normalizeSettings` 将 `BUILTIN_PROFILES` 注入到顶部；下次写回时 `stripBuiltinProfiles` 过滤，存储干净
- 导入/导出：导出时仅导出用户的 profile（不含内置）；导入时若有 `builtin-*` id 冲突则改名为 `imported-builtin-*`
- 任务回放：`TaskRecord.apiProfileId` 若指向 `builtin-*`，恢复时先查内置列表（保证 sub2api 升级 key 后旧任务仍可重放）
- 「重置应用」清空 localStorage 后，内置 profile 仍存在于代码 / env，下一次启动自动出现

## 11. 构建顺序（实现期建议）

1. `types.ts` + `apiProfiles.ts` 内建 provider 扩展 + 默认值 + `switchApiProfileProvider` + `normalizeApiProfile` + `isBuiltinProfile`
2. `builtinProfiles.ts` + 测试：env JSON 解析、id 前缀强制、Gemini 示例数据
3. `store.ts`：`normalizeSettings` 调用处注入 / 写回前剥离内置 profile；测试覆盖 round-trip
4. `geminiImageApi.ts` 纯函数 `buildGeminiRequestBody` / `parseGeminiResponse` + 测试
5. `geminiImageApi.ts` `callGeminiImageApi` + mock fetch 测试
6. `api.ts` 接入
7. `SettingsModal.tsx` provider 下拉 + 内置徽章 + readonly 表单 + 复制按钮
8. InputBar / DetailModal 中按 `provider === 'gemini'` 隐藏控件
9. 手动跑通：env 注入一份 sub2api Gemini 内置 profile → 启动 → 看到「内置」徽章 → 激活 → 生图

每步可独立提交并跑 `npm run test`。
