import type { CanvasEditor } from './editor'
import { Box } from './geometry'

/** 一个模型输入条目：一张选中图片 + 与其重叠的图形标注（合成时裁到该图范围）。 */
export interface CanvasInputEntry {
  imageId: string
  box: Box
  graphicIds: string[]
}

/** 选区分析结果：提交与生成条预览共用同一份「计划」，保证所见即所得。 */
export interface CanvasSelectionPlan {
  entries: CanvasInputEntry[]
  /** 是否存在标注（图形或文字）。为 true 时上层注入「按标注改、输出干净图」指令。 */
  annotated: boolean
  /** 从文字标注提取的纯文本，拼进 prompt 当修改指令。 */
  annotationText: string
}

export interface RasterizedSelection {
  /** 喂给模型的参考图 dataUrl 列表——每个 entry 一个条目（决策 5：不把多图拼一张）。 */
  dataUrls: string[]
  /** 图片的联合包围盒（页面坐标），结果放置基准。 */
  bounds: Box
  annotated: boolean
  annotationText: string
}

/**
 * 分析当前选区：选中的图片 + **自动跟随的标注簇**。
 * 标注不要求被显式选中——用户在图上画完标注后只需选中图片即可：
 * 显式选中的非图片元素直接算标注；未选中的非图片元素若与「图片 ∪ 已纳入标注」
 * 传递重叠（画在图上的圈 → 圈上引出的箭头 → 箭头指向的文字），也自动纳入。
 * 文字标注（text 元素，含图形的绑定文字标签）抽成 annotationText；text 元素不画进图。
 * 返回 null 表示选区里没有图片。生成占位框不是标注，排除。
 */
export function analyzeSelection(editor: CanvasEditor): CanvasSelectionPlan | null {
  const selected = editor.getSelectedIds()
  if (selected.length === 0) return null

  const images = selected
    .filter((id) => editor.getElement(id)?.type === 'image')
    .map((id) => ({ id, box: editor.getElementPageBounds(id) }))
    .filter((entry): entry is { id: string; box: Box } => entry.box !== undefined)
  if (images.length === 0) return null

  const selectedSet = new Set(selected)
  const pending = new Map(
    editor
      .getElements()
      .filter((el) => el.type !== 'image' && !editor.isPlaceholder(el))
      .map((el) => [el.id, editor.getElementPageBounds(el.id)]),
  )
  const clusterBoxes = images.map((img) => img.box)
  const annotationIds: string[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const [id, box] of pending) {
      if (!box) {
        pending.delete(id)
        continue
      }
      if (selectedSet.has(id) || clusterBoxes.some((cb) => cb.collides(box))) {
        annotationIds.push(id)
        clusterBoxes.push(box)
        pending.delete(id)
        grew = true
      }
    }
  }

  const textParts: string[] = []
  const graphics: Array<{ id: string; box: Box }> = []
  for (const id of annotationIds) {
    const el = editor.getElement(id)
    if (!el) continue
    const text = el.type === 'text' ? el.text.trim() : ''
    if (text) textParts.push(text)
    // text 元素内容已抽为文本，本身不画进图；其余图形标注（圈/箭头/draw）画进图。
    if (el.type !== 'text') {
      const box = editor.getElementPageBounds(id)
      if (box) graphics.push({ id, box })
    }
  }

  const entries: CanvasInputEntry[] = images.map(({ id, box }) => ({
    imageId: id,
    box,
    graphicIds: graphics.filter((g) => g.box.collides(box)).map((g) => g.id),
  }))

  return {
    entries,
    annotated: annotationIds.length > 0,
    annotationText: textParts.join('\n'),
  }
}

/**
 * 栅格化一个输入条目：带图形标注 → 图片连同标注合成、裁到该图范围；无标注 → 干净直出。
 * scale<1 用于生成条的低成本预览缩略图（与提交同一条逻辑，所见即所得）。
 * 背景填不透明白底，避免上游模型收到透明通道（editor.toImage 内置）。
 */
export async function rasterizeEntry(
  editor: CanvasEditor,
  entry: CanvasInputEntry,
  scale = 1,
): Promise<string | null> {
  const ids = entry.graphicIds.length === 0 ? [entry.imageId] : [entry.imageId, ...entry.graphicIds]
  return editor.toImage(ids, {
    scale,
    ...(entry.graphicIds.length > 0 ? { bounds: entry.box } : {}),
  })
}

/** 把当前选区栅格化为模型参考图（提交用，全尺寸）。无图片选区 → null（上层走文生图）。 */
export async function rasterizeSelection(
  editor: CanvasEditor,
): Promise<RasterizedSelection | null> {
  const plan = analyzeSelection(editor)
  if (!plan) return null
  const bounds = Box.Common(plan.entries.map((entry) => entry.box))

  const rasterized = await Promise.all(plan.entries.map((entry) => rasterizeEntry(editor, entry)))
  const dataUrls = rasterized.filter((url): url is string => url !== null)
  if (dataUrls.length === 0) return null

  return { dataUrls, bounds, annotated: plan.annotated, annotationText: plan.annotationText }
}
