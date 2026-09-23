/**
 * 画布上那几个浮动面板里的输入框。
 *
 * 不用 `components/panelStyles` 的 `FIELD`：它的 focus 态同时换边框色又加一圈 2px 焦点环，
 * 在这种紧贴画布的深底小面板上就是一块大绿框。这里只要一道细线，聚焦时亮一点就够，
 * 其余层次交给面板本身。
 */
export const CANVAS_PANEL_FIELD =
  'w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none dark:border-white/[0.08]'
