import {
  AssetRecordType,
  createShapeId,
  type Editor,
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
import { PLACEMENT_GAP, type PlacementTarget } from './placement'

/** 统一的错误消息提取（画布任务终局共用）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 读占位框 meta（决策 2 的持久真相源）。 */
export function readTaskMeta(shape: GenerationPlaceholderShape): CanvasTaskMeta {
  return shape.meta as unknown as CanvasTaskMeta
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
    meta: { ...shape.meta, ...patch },
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
 */
export async function settleGeneration(
  editor: Editor,
  placeholderId: TLShapeId,
  target: PlacementTarget,
  result: CallApiResult,
): Promise<void> {
  if (result.images.length === 0) {
    markPlaceholderStatus(editor, placeholderId, 'error', '生成完成但未返回图片')
    return
  }
  await placeResults(editor, placeholderId, target, result.images)
}

/**
 * 把 dataUrl 列表作为新的 image shape 放到画布并选中。
 * - 位置：以 target 左边界为起点、垂直居中于 target 中心
 * - 多张沿水平方向依次排布，彼此留 PLACEMENT_GAP 间距
 * 供「占位框替换为结果」与「工作台图片送进画布」两处复用（都不依赖占位框存在）。
 */
export async function placeImagesOnCanvas(
  editor: Editor,
  dataUrls: string[],
  target: PlacementTarget,
): Promise<void> {
  const centerY = target.y + target.h / 2
  const sizes = await Promise.all(dataUrls.map(getImageDimensions))

  const shapeIds: TLShapeId[] = []
  let x = target.x
  for (let i = 0; i < dataUrls.length; i++) {
    const { width, height } = sizes[i]
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
      x,
      y: centerY - height / 2,
      props: { assetId, w: width, h: height },
    })
    shapeIds.push(shapeId)
    x += width + PLACEMENT_GAP
  }
  if (shapeIds.length > 0) editor.setSelectedShapes(shapeIds)
}

/**
 * 把生成结果放到画布并**删除**占位框：占位框还在就放在它的位置（选区右侧、垂直居中），
 * 已被用户删除则按 target 兜底放置，不抛错（决策 7 末行 / spec 占位框缺失）。
 */
async function placeResults(
  editor: Editor,
  placeholderId: TLShapeId,
  target: PlacementTarget,
  dataUrls: string[],
): Promise<void> {
  const placeholder = getPlaceholder(editor, placeholderId)
  const anchor = placeholder ? targetFromShape(placeholder) : target
  if (placeholder) editor.deleteShape(placeholderId)
  await placeImagesOnCanvas(editor, dataUrls, anchor)
}
