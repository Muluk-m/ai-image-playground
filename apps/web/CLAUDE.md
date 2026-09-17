# apps/web

前端工作台内部约定。仓库级约定见根 `CLAUDE.md`。

## 服务商架构

前端 dispatch 入口在 [`src/lib/api.ts`](./src/lib/api.ts) 的 `callImageApi`，按 profile.source 分两条路径：

| profile.source | 实现路径 | 协议 |
|---|---|---|
| `user-byok` | `openaiCompatibleImageApi.ts` / `geminiImageApi.ts` | 浏览器直连用户填的 baseUrl |
| `builtin-edge` | `queueClient.ts` | 浏览器 → BFF queue（`submit / poll / fetch`） |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`** — 浏览器 CORS preflight 对常见中转网关只放行前者；后端代理通常两个 header 都接受。

## UI 组件与样式

**交互控件一律用 shadcn 组件，不要手搓原生控件。** 复选框、下拉、对话框、开关这类东西
自己拿 `<input type="checkbox">` + `appearance-none` 拼，拼出来的既没有统一状态样式，
也扛不住任何作用域 CSS。

[`components.json`](./components.json) 与 [`src/components/ui/`](./src/components/ui) 已就位，
token 在 [`src/styles/theme.css`](./src/styles/theme.css)（见
[`docs/design/creation-studio.md`](../../docs/design/creation-studio.md)），
`tailwind.config.js` 把它们映射成 `bg-primary` / `border-input` / `ring` 这些类。
目前有 checkbox、select、label、input、textarea。**`ui/` 下与 `apps/admin` 同名的文件一律
保持逐字节相同**（现在是 select / label / input / textarea，外加 `src/lib/utils.ts`），
由 [`parity.test.ts`](./src/__tests__/components/ui/parity.test.ts) 守着，改一边就会失败。
需要改行为时改调用点，别改原语。加组件用 `pnpm dlx shadcn@latest add <name>`，
**加依赖必须带着 `private/` 重新生成 lockfile**，见仓库根 `CLAUDE.md`。

分两层：`src/components/ui/` 是 shadcn 原语，按上游约定用 `@/` 别名，尽量不改，方便
CLI 覆盖更新；`src/components/` 下是项目自己的组合层（`Checkbox` 管勾选框加标签、
`Field` 管标签加控件），用相对路径，业务代码只引这一层。

**测 Radix 组件要给 jsdom 补三样东西**：pointer capture、`ResizeObserver`，以及带
`pointerType: 'mouse'` 的指针事件——Radix 的下拉只认这一种，拿 `MouseEvent` 直接派发
`pointerdown` 打不开它。勾选框渲染成 `[role="checkbox"]` 的 button 而不是 `<input>`，
选项渲染在 portal 里要从 `document` 找。现成写法见
[`directorGeneration.test.tsx`](./src/__tests__/features/video/storyboard/components/directorGeneration.test.tsx)。

**作用域 CSS 不要用裸元素选择器。** `.video-director button { padding: 8px 12px }` 的
specificity 是 (0,1,1)，压得过 `.h-5`、`.flex` 这类 (0,1,0) 的 utility，容器里所有复用组件
会被一起压散（2026-09 导演台事故：Checkbox 被拉成全宽长条、参考图删除按钮变形）。
必须写成 `:where(.video-director) button`，把 class 那一位让出去：(0,0,1) 仍然压得过
preflight，但任何一个 utility 都能覆盖它。约束由
[`src/__tests__/features/video/storyboard/components/directorCss.test.ts`](./src/__tests__/features/video/storyboard/components/directorCss.test.ts) 守着。

`director.css` 里表单那几类 reset 已经拆掉了——控件改用组件，样式跟着组件走。
剩下的是 `button` 与 h2/h3/p/small 这些排版，等 78 个裸 `<button>` 迁到组件后一并收掉。
在那之前，新组件落进导演台要显式声明自己的 `padding` / `background`，`button` reset
会漏进 Radix 渲染出来的按钮（`ui/checkbox.tsx` 的 `p-0 bg-background` 就是为此）。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 [`src/lib/fetchProfileModels.ts`](./src/lib/fetchProfileModels.ts)，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
