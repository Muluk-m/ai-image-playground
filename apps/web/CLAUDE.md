# apps/web

前端工作台内部约定。仓库级约定见根 `CLAUDE.md`。

## 服务商架构

前端 dispatch 入口在 [`src/lib/api.ts`](./src/lib/api.ts) 的 `callImageApi`，按 profile.source 分两条路径：

| profile.source | 实现路径 | 协议 |
|---|---|---|
| `user-byok` | `openaiCompatibleImageApi.ts` / `geminiImageApi.ts` | 浏览器直连用户填的 baseUrl |
| `builtin-edge` | `queueClient.ts` | 浏览器 → BFF queue（`submit / poll / fetch`） |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`** — 浏览器 CORS preflight 对常见中转网关只放行前者；后端代理通常两个 header 都接受。

## 多语言（i18n）

运行时是 **react-i18next + 结构化 key**，语料是每个 locale 一份 JSON，业务代码只认 key。

- 入口 [`src/i18n/index.ts`](./src/i18n/index.ts)：静态 import 全部 catalog，`initImmediate: false`
  **同步**初始化。组件首帧就能拿到译文——测试里 `root.render(<X/>)` 不 await，异步初始化会让
  断言读到 key 而不是文案。
- **组件从 `../i18n` 取 `useTranslation`，不要直接 import `react-i18next`**：导入我们这个模块
  才会触发初始化，绕过去就会出现「先渲染后初始化」。
- 命名空间即语料文件：`common`（跨 feature 共用）、`auth`、`errors`、`task`…
  新 feature 加一个同名 namespace，别往 `common` 里堆。
- key 形如 `<component>.<intent>`，例如 `auth:login.emailPlaceholder`。
- **错误文案走 `errors:<flow>.<code>`，叶子名与 BFF 返回的 `error.code` 同名。** 同一个 code 在
  不同流程下措辞不同（登录的 `rate_limited` ≠ 注册的 `rate_limited`），所以按 flow 分组而不是拍平。
  每组都要有 `fallback`。
- **错误与校验提示在 state 里存 key，渲染时才翻译**，切语言后已经显示的报错会跟着变。直接存译文
  就会卡在切换前的语言上。
- 复数用 i18next 的 `count` 参数加 `_one` / `_other` 后缀。**后缀是 locale 的属性**：中文只该有
  `_other`，英文要 `_one` + `_other`；多写的后缀是死 key，少写的会回退。
- `fallbackLng` 是 `zh-CN`：英文缺 key 时显示中文，而不是把 key 漏给用户。
- 语言选择存 `localStorage` 的 `aip.locale`；没存过时按 `navigator.languages` 探测。
  切换时同步更新 `document.documentElement.lang`（`index.html` 里写死的 `zh-CN` 只是初值）。
- **测试里 locale 必须钉死**：jsdom 的 `navigator.languages` 是 `['en-US']`，不钉死的话所有断言
  中文文案的历史用例会整片变红。已由 [`src/__tests__/setup/i18n.ts`](./src/__tests__/setup/i18n.ts)
  在每个用例前 `changeLanguage('zh-CN')`，通过 `vite.config.ts` 的 `test.setupFiles` 挂上。
- `src/i18n/index.ts` 里的 `declare module 'i18next'` 把中文 catalog 的形状喂给 i18next：
  **写错 key 或漏建 key 在 `pnpm typecheck` 就红**，不用等运行时。因此新增文案要先加中文
  catalog 再写调用。这段**必须留在 `index.ts` 里**——独立的 `.d.ts` 要靠各 tsconfig 的
  `include` 捞进来，`private/apps/web/tsconfig.json` 没有捞，那个工程里 key 会退回无类型。
- [`src/__tests__/i18n/catalog.test.ts`](./src/__tests__/i18n/catalog.test.ts) 守三件事：
  两种语言 key 集合一致、插值占位符一致、复数后缀覆盖该 locale 的全部 plural category。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 [`src/lib/fetchProfileModels.ts`](./src/lib/fetchProfileModels.ts)，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
