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

现状是**只有 token 没有组件库**：[`src/styles/theme.css`](./src/styles/theme.css) 提供了
shadcn 语义 token（`--primary` / `--border` / `--card` …，见
[`docs/design/creation-studio.md`](../../docs/design/creation-studio.md)），但 `apps/web` 还没有
`components.json` 和 `src/components/ui/`——`Checkbox`、`SELECT` 这些都是手写的。
新建交互控件前先把组件库装上（`apps/admin/components.json` 是现成参照），碰到手写的老控件
顺手换掉；加依赖必须带着 `private/` 重新生成 lockfile，见仓库根 `CLAUDE.md`。

**作用域 CSS 不要用裸元素选择器。** `.video-director button { padding: 8px 12px }` 的
specificity 是 (0,1,1)，压得过 `.h-5`、`.flex` 这类 (0,1,0) 的 utility，容器里所有复用组件
会被一起压散（2026-09 导演台事故：Checkbox 被拉成全宽长条、参考图删除按钮变形）。
必须写成 `:where(.video-director) button`，把 class 那一位让出去：(0,0,1) 仍然压得过
preflight，但任何一个 utility 都能覆盖它。约束由
[`src/__tests__/features/video/storyboard/components/directorCss.test.ts`](./src/__tests__/features/video/storyboard/components/directorCss.test.ts) 守着。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 [`src/lib/fetchProfileModels.ts`](./src/lib/fetchProfileModels.ts)，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
