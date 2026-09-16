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

- 入口 [`src/i18n/index.ts`](./src/i18n/index.ts)：静态 import 中文 catalog，`initAsync: false`
  **同步**初始化（这个选项在 i18next v25 之前叫 `initImmediate`）。组件首帧就能拿到译文——
  `main.tsx` 与测试都是 import 完直接 render，异步初始化会让首帧渲染出 key 而不是文案。
- **英文语料是按需 chunk**（gzip 约 20 KB）：中文既是默认语言又是 fallback，必须随首屏到；
  英文只在切过去时由 `ensureLocaleLoaded` 动态 import。所以 `setLocale` 是 **async** 的，
  调用处要 `void setLocale(...)` 或 `await`。启动时 `main.tsx` 会 `await bootstrapLocale()`。
- **组件从 `../i18n` 取 `useTranslation`，不要直接 import `react-i18next`**：导入我们这个模块
  才会触发初始化，绕过去就会出现「先渲染后初始化」。
- 命名空间即语料文件，现有 15 个：`common` `auth` `errors` `task` `settings` `composer`
  `shell` `store` `lib` `productShots` `video` `library` `canvas` `agent` `inspiration`。
  新 feature 加一个同名 namespace 并在两个 `locales/*/index.ts` 聚合入口里登记，别往 `common` 里堆。
- key 形如 `<component>.<intent>`，例如 `auth:login.emailPlaceholder`。
- **跨命名空间取词要把 `common` 一起声明**：`useTranslation('task')` 返回的 `t` 只接受 task 的 key，
  写 `t('common:action.cancel')` 会 TS2345。正确写法是 `useTranslation(['task', 'common'])`，
  数组第一项仍是默认命名空间，不带前缀的 key 照常落在 task。另开一个
  `const { t: tCommon } = useTranslation('common')` 也可以。
- **非 React 模块用 `i18next.getFixedT(null, '<ns>')`**，不要手写
  `type Key = Parameters<typeof i18next.t>[0]`——那拿到的是全部命名空间的并集，配上 `ns`
  反而对不上，key 会失去编译期检查。`getFixedT` 第一个参数传 `null` 表示不钉语言，
  每次调用仍取当前 locale。
- **错误文案走 `errors:<flow>.<code>`，叶子名与 BFF 返回的 `error.code` 同名。** 同一个 code 在
  不同流程下措辞不同（登录的 `rate_limited` ≠ 注册的 `rate_limited`），所以按 flow 分组而不是拍平。
  每组都要有 `fallback`。
- **错误与校验提示在 state 里存 key，渲染时才翻译**，切语言后已经显示的报错会跟着变。直接存译文
  就会卡在切换前的语言上。
- 复数用 i18next 的 `count` 参数加 `_one` / `_other` 后缀。**后缀是 locale 的属性**：中文只该有
  `_other`，英文要 `_one` + `_other`；多写的后缀是死 key，少写的会回退。
- `fallbackLng` 是 `zh-CN`：英文缺 key 时显示中文，而不是把 key 漏给用户。
- **模块级常量不能存译文**：模块求值发生在 `bootstrapLocale()` 之前，直接 `i18next.t()` 会把
  中文烤死，切语言后也不会更新。三种已在用的做法，按调用方改动成本选：
  getter 对象（`store.ts` 的 `APP_MODE_LABELS`，消费方按 `X[key]` 索引，零改动）、
  惰性函数（`video/types.ts`，消费方加一对括号）、
  `export let` + `i18next.on('languageChanged')` 重算（`lib/shotTypes.ts`，靠 ESM live binding，
  消费方完全零改动，代价是可变导出）。
  [`src/__tests__/i18n/liveBindings.test.ts`](./src/__tests__/i18n/liveBindings.test.ts) 钉住第三种。
- **React 组件只有调用了 `useTranslation()` 才会在切语言时重渲染。** 只用 `i18next.t()` 取值的
  组件不会。`memo` 包住的子组件要自己调一次，父组件重渲染拦不过去。
  一次性产出的文案（toast、写进记录的 error）用 `i18next.t()` 直调是对的，它不需要重渲染。
- **这些中文不要翻**，它们是数据不是文案，翻了会静默改行为：发给大模型的提示词与其中的枚举值、
  被持久化且参与相等比较的配置名、匹配上游中文报错的正则、写进提示词再被正则反解析的哨兵。
  界面要显示它们时，另建一张只管显示的查表函数，数据值原样保留。
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
  复数那条取**两种语言 plural base 的并集**再逐 locale 检查——只看各自的 base 会漏掉
  「一边写 `x_one`/`x_other`、另一边写成无后缀的 `x`」这种不对称，运行时缺后缀那边会落空。
- `pnpm i18n:check` 体检死 key（语料里有、代码里没人引用）。反方向由类型增强在 typecheck 兜住。
- 私有 overlay 自带语料与接缝：`private/apps/web/i18n.ts` 导出 `tBilling`，在 overlay 加载时
  把 `billing` 命名空间注册进同一个 i18next 实例。它不复用公开树的 `declare module`——
  `CustomTypeOptions.resources` 只能声明一次，两处声明会冲突。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 [`src/lib/fetchProfileModels.ts`](./src/lib/fetchProfileModels.ts)，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
