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
- 命名空间即语料文件，现有 14 个：`common` `auth` `errors` `task` `settings` `composer`
  `shell` `store` `lib` `video` `library` `canvas` `agent` `inspiration`。
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
  惰性函数（`features/video/lib/labels.ts`，消费方加一对括号）、
  `export let` + `i18next.on('languageChanged')` 重算（`lib/inputImageLimit.ts`，靠 ESM live binding，
  消费方完全零改动，代价是可变导出）。
  [`src/__tests__/i18n/liveBindings.test.ts`](./src/__tests__/i18n/liveBindings.test.ts) 钉住第三种。
- **React 组件只有调用了 `useTranslation()` 才会在切语言时重渲染。** 只用 `i18next.t()` 取值的
  组件不会。`memo` 包住的子组件要自己调一次，父组件重渲染拦不过去。
  一次性产出的文案（toast、写进记录的 error）用 `i18next.t()` 直调是对的，它不需要重渲染。
- **这些中文不要翻**，它们是数据不是文案，翻了会静默改行为：发给大模型的提示词与其中的枚举值、
  被持久化且参与相等比较的配置名、匹配上游中文报错的正则、写进提示词再被正则反解析的哨兵。
  界面要显示它们时，另建一张只管显示的查表函数，数据值原样保留。
- **存储格式与显示标签分开**：引用的哨兵 `@图N` 是存储格式，由 `getSelectedImageMentionLabel` 产出，
  永不随语言变；胶囊上显示的序号标签由 `getImageMentionLabel` 产出，是界面文案（英文 `@Image 1`）。
  按标签解析器做缓存的 `useMemo` 要把 `i18n.language` 列进依赖。`@` 菜单匹配不分语言。
- **初值文案**（系统替用户写进数据的第一份文字）按写入那一刻的界面语言取，写完不再翻译、不迁移。
  配置档案的默认名、复制后缀在 [`src/lib/profileSeedNames.ts`](./src/lib/profileSeedNames.ts)，
  刻意不进按需加载的语料：判断「没动过的新配置」要同时认所有语言的默认名。
  例外是「未命名项目」：它表示「没有名字」，存的是固定哨兵，显示时才查译文。
- **语料里不允许空值**，空字符串一律当漏翻（`catalog.test.ts` 守着）。要按语言隐藏某段界面，
  写显式规则，例如品牌字标的 `brandNeedsWordmark()`。
- **主题**在 [`src/theme/`](./src/theme/index.ts)：没选过跟随系统，选了固定在本机（`aip.theme`）。
  暗色由 `<html>` 上的 `.dark` 决定，Tailwind 是 `darkMode: 'class'`，手写样式用 `.dark …` 选择器，
  **不要再写 `@media (prefers-color-scheme)`**，也不要在 JS 里读系统明暗，要重画就 `subscribeTheme`。
  首帧脚本 `bootScript.ts` 由 Vite 插件内联进 head，它与 `resolveTheme` 是同一条规则的两份实现，
  `theme.test.ts` 逐格比对；改一边必须改另一边。头像菜单与登录页只做亮暗翻转，
  「跟随系统」只在设置面板里。 `theme-color` 由首帧脚本创建并随主题更新；PWA 清单里的颜色改不了，
  安装态的启动画面固定是暗色，不是 bug。
- 界面语言（以及主题）是**显示设置**：只存本机、登录前生效、不进同步。登录后的入口在头像菜单的
  [`DisplaySettingsMenuItems`](./src/components/DisplaySettingsMenuItems.tsx)，公开树与私有 overlay
  的两个头像菜单渲染同一个组件；登录页与设置面板另有入口。标签页标题随语言变，静态 meta 不变。
- `lib/localCompatibility/` 刻意零依赖（它在 App 与 store 之前跑，还单独打进旧域名的入口），
  里面的两条中文报错不迁移。
- 语言选择存 `localStorage` 的 `aip.locale`；没存过时按 `navigator.languages` 探测。
  切换时同步更新 `document.documentElement.lang`（`index.html` 里写死的 `zh-CN` 只是初值）。
- **测试里 locale 必须钉死**：jsdom 的 `navigator.languages` 是 `['en-US']`，不钉死的话所有断言
  中文文案的历史用例会整片变红。已由 [`src/__tests__/setup/i18n.ts`](./src/__tests__/setup/i18n.ts)
  在每个用例前 `changeLanguage('zh-CN')`，通过 `vite.config.ts` 的 `test.setupFiles` 挂上。
- `src/i18n/index.ts` 里的 `declare module 'i18next'` 把中文 catalog 的形状喂给 i18next：
  **写错 key 或漏建 key 在 `pnpm typecheck` 就红**，不用等运行时。因此新增文案要先加中文
  catalog 再写调用。这段**必须留在 `index.ts` 里**——独立的 `.d.ts` 要靠各 tsconfig 的
  `include` 捞进来，`private/apps/web/tsconfig.json` 没有捞，那个工程里 key 会退回无类型。
- [`src/__tests__/i18n/catalog.test.ts`](./src/__tests__/i18n/catalog.test.ts) 守四件事：
  两种语言 key 集合一致、插值占位符一致、复数后缀覆盖该 locale 的全部 plural category、没有空值。
  复数那条取**两种语言 plural base 的并集**再逐 locale 检查——只看各自的 base 会漏掉
  「一边写 `x_one`/`x_other`、另一边写成无后缀的 `x`」这种不对称，运行时缺后缀那边会落空。
- `pnpm i18n:check` 体检死 key（语料里有、代码里没人引用）。按稳定 id 用模板拼出来的 key
  字面量搜不到，要把前缀登记进脚本的 `DYNAMIC_PREFIXES`。反方向由类型增强在 typecheck 兜住。
- 私有 overlay 自带语料与接缝：`private/apps/web/i18n.ts` 导出 `tBilling`，在 overlay 加载时
  把 `billing` 命名空间注册进同一个 i18next 实例。它不复用公开树的 `declare module`——
  `CustomTypeOptions.resources` 只能声明一次，两处声明会冲突。

## UI 组件与样式

**交互控件一律用 shadcn 组件，不要手搓原生控件。** 复选框、下拉、对话框、开关这类东西
自己拿 `<input type="checkbox">` + `appearance-none` 拼，拼出来的既没有统一状态样式，
也扛不住任何作用域 CSS。

[`components.json`](./components.json) 与 [`src/components/ui/`](./src/components/ui) 已就位，
token 在 [`src/styles/theme.css`](./src/styles/theme.css)（见
[`docs/design/creation-studio.md`](../../docs/design/creation-studio.md)），
`tailwind.config.js` 把它们映射成 `bg-primary` / `border-input` / `ring` 这些类。
目前有 checkbox、select、label、input、textarea。**`ui/` 下与 `apps/admin` 同名的文件一律
保持逐字节相同**（现在是 select / label / input，外加 `src/lib/utils.ts`），
由 [`parity.test.ts`](./src/__tests__/components/ui/parity.test.ts) 守着，改一边就会失败。
需要改行为时改调用点，别改原语。加组件用 `pnpm dlx shadcn@latest add <name>`，
**加依赖必须带着 `private/` 重新生成 lockfile**，见仓库根 `CLAUDE.md`。

分两层：`src/components/ui/` 是 shadcn 原语，按上游约定用 `@/` 别名，尽量不改，方便
CLI 覆盖更新；`src/components/` 下是项目自己的组合层（如 `Checkbox` 管勾选框加标签），用相对路径，业务代码只引这一层。

**测 Radix 组件要给 jsdom 补三样东西**：pointer capture、`ResizeObserver`，以及带
`pointerType: 'mouse'` 的指针事件——Radix 的下拉只认这一种，拿 `MouseEvent` 直接派发
`pointerdown` 打不开它。勾选框渲染成 `[role="checkbox"]` 的 button 而不是 `<input>`，
选项渲染在 portal 里要从 `document` 找。现成写法见
[`helpers/radix.ts`](./src/__tests__/helpers/radix.ts) 与它在
[`agentComposerMode.test.tsx`](./src/__tests__/features/agent/components/agentComposerMode.test.tsx) 里的用法。

**作用域 CSS 不要用裸元素选择器。** `.panel button { padding: 8px 12px }` 的 specificity 是
(0,1,1)，压得过 `.h-5`、`.flex` 这类 (0,1,0) 的 utility，容器里所有复用组件会被一起压散
（2026-09 已下线的导演台出过这事故：勾选框被拉成全宽长条）。必须写成 `:where(.panel) button`，
把 class 那一位让出去：(0,0,1) 仍然压得过 preflight，但任何一个 utility 都能覆盖它。

**界面上不解释系统行为。** 「点这个会把命令放进输入框交给智能体」「保存后可以在素材页改名」
「手动保存只存上传图」这类描述能力与流程的句子，是代码注释，不是界面文案：用户看到的必须是
干净的控件与结果。表达方式只有三种——控件本身的标签（按钮写清动作）、动作发生后的即时反馈
（toast、卡片状态翻转）、空态里最多一句话说「这里放什么、怎么开始」。原型也遵守同一条，
原型的说明写在代码注释或 issue 里。需要长解释的功能是设计问题，回去改设计，不要加脚注。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 [`src/lib/fetchProfileModels.ts`](./src/lib/fetchProfileModels.ts)，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
