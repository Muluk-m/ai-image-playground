# 画布（create 模式）待办

## TODO: 换掉 tldraw，改用无 license 依赖的库自建

**背景**：tldraw 5.x 在生产域名（非 localhost 的 https）下若无 license key，会在渲染 5 秒后
把整个编辑器 `display:none`（黑屏）——见 `@tldraw/editor` 的 `LicenseProvider.tsx`
（`unlicensed-production` 状态）。当前用一个**免费 watermark license key**
（`apps/web/.env.production` 的 `VITE_TLDRAW_LICENSE_KEY`）绕过，角落会有 "made with tldraw" 水印。

该 key 域名绑定 + 有期限（`tldraw-2026-07-15`），**被回收 / 过期后画布会再次黑屏**。届时二选一：
1. 去 https://tldraw.dev 换一个免费 key，替换 `.env.production` 里的值（改一行、几分钟）。
2. **换库自建**（本 TODO），彻底摆脱 license 依赖。

**迁移面（业务逻辑与 tldraw 解耦，换库只动这 4 处「editor 适配层」）**：

- `shapes/GenerationPlaceholderShapeUtil.tsx` — tldraw 自定义 shape（占位框）。换库需用目标库的
  自定义元素/图层机制重写。
- `lib/rasterizeSelection.ts` — 依赖 `editor.toImage()` 把选中图片各自栅格化为 dataUrl。
- `lib/placeholderShapeOps.ts` — 依赖 tldraw 的 asset/shape 创建 API（`createAssets`/`createShape`）。
- `components/CanvasMode.tsx` — `<Tldraw>` 挂载、暗色 + 点阵网格、`persistenceKey` 持久化、`onMount` 恢复。

**不用动的（与 tldraw 无关，是画布的真正价值）**：
`lib/submitFromCanvas.ts`（任务发起/并发/重试）、`lib/recoverCanvasTasks.ts`（持久化恢复分支）、
`lib/placement.ts`（放置算法）、`lib/canvasTaskRuntime.ts`（内存运行态）——底层生成走复用的
`callImageApi` / `resumeQueueImageApi`，全程不碰 tldraw。

**候选库**：Excalidraw（自定义元素受限）、react-konva（自由但要自建交互/持久化）、
tldraw 旧 OSS 版（无 license 闸，但功能与生态落后）。选型时权衡「自定义 shape 能力 + 持久化 + 交互成本」。
