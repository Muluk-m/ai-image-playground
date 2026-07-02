import {
  AssetRecordType,
  createShapeId,
  type Editor,
  type JsonObject,
  type TLImageShape,
  type TLShapeId,
} from 'tldraw'
import { getImageDimensions } from '../../../lib/canvasImage'
import type { CallApiResult } from '../../../lib/imageApiShared'
import type {
  CanvasTaskMeta,
  CanvasTaskStatus,
  GenerationPlaceholderShape,
} from '../shapes/GenerationPlaceholderShapeUtil'
import { fitToTarget, PLACEMENT_GAP, type PlacementTarget } from './placement'

/** 统一的错误消息提取（画布任务终局共用）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 读占位框 meta（决策 2 的持久真相源）。 */
export function readTaskMeta(shape: GenerationPlaceholderShape): CanvasTaskMeta {
  return shape.meta as unknown as CanvasTaskMeta
}

/**
 * 写占位框 meta 的对称收口：CanvasTaskMeta 是 interface（无 index signature），
 * 与 tldraw JsonObject 的结构兼容在读（readTaskMeta）写（此处）两侧各一个 cast 收掉。
 */
export function toShapeMeta(meta: CanvasTaskMeta): JsonObject {
  return meta as unknown as JsonObject
}

/** 从占位框自身几何取放置目标（恢复 / 重试无内存运行态时的兜底）。 */
export function targetFromShape(shape: GenerationPlaceholderShape): PlacementTarget {
  return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h }
}

function getPlaceholder(editor: Editor, id: TLShapeId): GenerationPlaceholderShape | undefined {
  const shape = editor.getShape(id)
  return shape?.type === 'generation-placeholder'
    ? (shape as GenerationPlaceholderShape)
    : undefined
}

/** 把 bffRequestId 回填进占位框 meta 并持久化（决策 2）。占位框已被删则安全 no-op。 */
export function patchTaskMeta(editor: Editor, id: TLShapeId, patch: Partial<CanvasTaskMeta>): void {
  const shape = getPlaceholder(editor, id)
  if (!shape) return
  editor.updateShape<GenerationPlaceholderShape>({
    id,
    type: 'generation-placeholder',
    meta: toShapeMeta({ ...readTaskMeta(shape), ...patch }),
  })
}

/** 占位框转为错误 / 失效态（不再无限 loading）。占位框已被删则安全 no-op。 */
export function markPlaceholderStatus(
  editor: Editor,
  id: TLShapeId,
  status: Exclude<CanvasTaskStatus, 'loading'>,
  message: string,
): void {
  const shape = getPlaceholder(editor, id)
  if (!shape) return
  editor.updateShape<GenerationPlaceholderShape>({
    id,
    type: 'generation-placeholder',
    props: { status, message },
  })
}

/**
 * 任务终局的单一收口（submit 与 recover 共用）：空结果 → 错误态；有结果 → 替换占位框。
 * 调用方只负责「怎么拿到 result」，终局态判定统一在这里，避免两条路径各写一份。
 * 返回是否成功落图，供调用方决定是否落工作台历史（历史写入属任务层，不在本 shape 层做）。
 */
export async function settleGeneration(
  editor: Editor,
  placeholderId: TLShapeId,
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
 * 把 dataUrl 列表作为新的 image shape 放到画布并选中；结果落在视口外时平滑移动镜头带到眼前
 * （在视口内则不动镜头，避免打断用户正在进行的操作）。
 * - 尺寸：按 target 框 contain 适配（asset 保留原始分辨率），不按原始像素落图
 * - 位置：居中于 target 框；多张按 target 宽度分格沿水平排开（与 fanOutTargets 对齐），
 *   彼此留 PLACEMENT_GAP 间距，各自在格内居中
 * - meta（可选）写到每个 image shape 上，承载生成溯源（prompt 等）
 * 供「占位框替换为结果」与「工作台图片送进画布」两处复用（都不依赖占位框存在）。
 */
export async function placeImagesOnCanvas(
  editor: Editor,
  dataUrls: string[],
  target: PlacementTarget,
  meta?: Record<string, string>,
): Promise<void> {
  const centerY = target.y + target.h / 2
  const sizes = await Promise.all(dataUrls.map(getImageDimensions))

  const shapeIds: TLShapeId[] = []
  for (let i = 0; i < dataUrls.length; i++) {
    const { width, height } = sizes[i]
    const fitted = fitToTarget(width, height, target)
    const cellX = target.x + i * (target.w + PLACEMENT_GAP)
    const assetId = AssetRecordType.createId()
    editor.createAssets([
      {
        id: assetId,
        typeName: 'asset',
        type: 'image',
        props: {
          name: 'generated.png',
          src: dataUrls[i],
          w: width,
          h: height,
          mimeType: 'image/png',
          isAnimated: false,
        },
        meta: {},
      },
    ])
    const shapeId = createShapeId()
    editor.createShape<TLImageShape>({
      id: shapeId,
      type: 'image',
      x: cellX + (target.w - fitted.w) / 2,
      y: centerY - fitted.h / 2,
      props: { assetId, w: fitted.w, h: fitted.h },
      meta: meta ?? {},
    })
    shapeIds.push(shapeId)
  }
  if (shapeIds.length === 0) return
  editor.setSelectedShapes(shapeIds)

  // 镜头反馈：结果完全在视口外（用户平移去了别处 / 恢复场景）时把镜头带过去，
  // 否则生成完了用户根本不知道图落在哪。视口内可见则不动。
  const placed = editor.getSelectionPageBounds()
  if (placed && !editor.getViewportPageBounds().collides(placed)) {
    editor.zoomToSelection({ animation: { duration: 320 } })
  }
}

/**
 * 把生成结果放到画布并**删除**占位框：占位框还在就放在它的位置（选区右侧、垂直居中），
 * 已被用户删除则按 target 兜底放置，不抛错（决策 7 末行 / spec 占位框缺失）。
 * 结果 shape 的 meta 记录生成溯源（prompt），画布上事后可查这张图是怎么来的。
 */
async function placeResults(
  editor: Editor,
  placeholderId: TLShapeId,
  target: PlacementTarget,
  dataUrls: string[],
): Promise<void> {
  const placeholder = getPlaceholder(editor, placeholderId)
  const anchor = placeholder ? targetFromShape(placeholder) : target
  const provenance = placeholder ? { prompt: readTaskMeta(placeholder).prompt } : undefined
  if (placeholder) editor.deleteShape(placeholderId)
  await placeImagesOnCanvas(editor, dataUrls, anchor, provenance)
}
