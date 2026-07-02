import { getImageDimensions } from '../../../lib/canvasImage'
import type { CallApiResult } from '../../../lib/imageApiShared'
import type { CanvasEditor, CanvasTaskStatus, PlaceholderView } from './editor'
import { Box } from './geometry'
import { PLACEMENT_GAP, type PlacementTarget } from './placement'

/** 统一的错误消息提取（画布任务终局共用）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 从占位框自身几何取放置目标（恢复 / 重试无内存运行态时的兜底）。 */
export function targetFromShape(view: PlaceholderView): PlacementTarget {
  return { x: view.x, y: view.y, w: view.w, h: view.h }
}

/** 占位框转为错误 / 失效态（不再无限 loading）。占位框已被删则安全 no-op。 */
export function markPlaceholderStatus(
  editor: CanvasEditor,
  id: string,
  status: Exclude<CanvasTaskStatus, 'loading'>,
  message: string,
): void {
  editor.updatePlaceholder(id, { status, message })
}

/**
 * 任务终局的单一收口（submit 与 recover 共用）：空结果 → 错误态；有结果 → 替换占位框。
 * 调用方只负责「怎么拿到 result」，终局态判定统一在这里，避免两条路径各写一份。
 * 返回是否成功落图，供调用方决定是否落工作台历史（历史写入属任务层，不在本层做）。
 */
export async function settleGeneration(
  editor: CanvasEditor,
  placeholderId: string,
  target: PlacementTarget,
  result: CallApiResult,
): Promise<boolean> {
  if (result.images.length === 0) {
    markPlaceholderStatus(editor, placeholderId, 'error', '生成完成但未返回图片')
    return false
  }
  await placeResults(editor, placeholderId, target, result.images)
  return true
}

/**
 * 把 dataUrl 列表作为新的 image 元素放到画布并选中；结果落在视口外时平滑移动镜头带到眼前
 * （在视口内则不动镜头，避免打断用户正在进行的操作）。
 * - 位置：以 target 左边界为起点、垂直居中于 target 中心
 * - 多张沿水平方向依次排布，彼此留 PLACEMENT_GAP 间距
 * - meta（可选）写到每个 image 元素上，承载生成溯源（prompt 等）
 * 供「占位框替换为结果」与「工作台图片送进画布」两处复用（都不依赖占位框存在）。
 */
export async function placeImagesOnCanvas(
  editor: CanvasEditor,
  dataUrls: string[],
  target: PlacementTarget,
  meta?: Record<string, string>,
): Promise<void> {
  const centerY = target.y + target.h / 2
  const sizes = await Promise.all(dataUrls.map(getImageDimensions))

  const items: Array<{ dataUrl: string; x: number; y: number; width: number; height: number }> = []
  let x = target.x
  for (let i = 0; i < dataUrls.length; i++) {
    const { width, height } = sizes[i]
    items.push({ dataUrl: dataUrls[i], x, y: centerY - height / 2, width, height })
    x += width + PLACEMENT_GAP
  }
  const ids = editor.placeImages(items, meta)
  if (ids.length === 0) return
  editor.setSelectedElements(ids)

  // 镜头反馈：结果完全在视口外（用户平移去了别处 / 恢复场景）时把镜头带过去，
  // 否则生成完了用户根本不知道图落在哪。视口内可见则不动。
  const placed = Box.Common(items.map((it) => new Box(it.x, it.y, it.width, it.height)))
  if (!editor.getViewportPageBounds().collides(placed)) {
    editor.scrollToElements(ids)
  }
}

/**
 * 把生成结果放到画布并**删除**占位框：占位框还在就放在它的位置（选区右侧、垂直居中），
 * 已被用户删除则按 target 兜底放置，不抛错（决策 7 末行 / spec 占位框缺失）。
 * 结果元素的 meta 记录生成溯源（prompt），画布上事后可查这张图是怎么来的。
 */
async function placeResults(
  editor: CanvasEditor,
  placeholderId: string,
  target: PlacementTarget,
  dataUrls: string[],
): Promise<void> {
  const placeholder = editor.getPlaceholder(placeholderId)
  const anchor = placeholder ? targetFromShape(placeholder) : target
  const provenance = placeholder ? { prompt: placeholder.meta.prompt } : undefined
  if (placeholder) editor.deleteElement(placeholderId)
  await placeImagesOnCanvas(editor, dataUrls, anchor, provenance)
}
