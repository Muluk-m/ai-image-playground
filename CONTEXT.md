# CONTEXT.md

项目领域与架构词汇表。架构讨论使用的术语（module / interface / depth / seam / adapter / leverage / locality）定义见 `/codebase-design` skill。

## Overlay（浮层）

所有模态浮层共享的深化模块（`apps/web/src/components/Overlay.tsx`）。接口 = 包装组件 `<Overlay onClose tier>{children}</Overlay>`，实现拥有五条纪律：

- **portal 到 `document.body`** — 浮层永远不受祖先 `transform` / `filter` / `backdrop-filter` 包含块影响（2026-08-04 SizePickerModal 事故的根因）
- **scroll-lock** — 组合 `usePreventBackgroundScroll`，内容 ref 自动作为滚动边界
- **ESC 栈** — 组合 `useCloseOnEscape`，一次只关最顶层
- **backdrop 关闭** — 内置 pointerdown-guard（pointerdown 与 click 都必须命中表面本身，才关闭，防划词误关）；暗化层 `pointer-events-none`，否则它盖在表面之上、命中的永远是它，点击永不关闭。需要自定义表面交互（如 Lightbox 的缩放感知点击）的调用方用 `backdrop="none"`，在自己的内容根上挂 handler
- **z 层三档** — `modal`（z-50 基底模态）/ `raised`（z-100 嵌套子弹窗、需压过其它模态的）/ `alert`（z-110 ConfirmDialog 类）

纪律：模态类浮层一律经 Overlay 渲染内容，不得自己写 `fixed inset-0` + portal。定位型浮层（Tooltip、Select 下拉、拖拽预览）不属于 Overlay，另是一类。

## 测试

- `apps/web` 有 jsdom 环境（按文件 `@vitest-environment jsdom` 启用），组件级冒烟测试的入口；Overlay 是首个有 DOM 锚点的模块。
