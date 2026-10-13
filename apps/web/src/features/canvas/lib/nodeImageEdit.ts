import { canvasMainResult, chooseCanvasResult, readCanvasDocument } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { canvasToBlob, loadImage } from '../../../lib/canvasImage'
import { blobDataUrl, resolveMediaSource } from '../../../lib/cloudMedia'
import { prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import { useStore } from '../../../store'
import type { ImageEl } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { exportMaskDataUrl, type MaskStroke, paintMaskStroke } from './inpaintMask'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { submitNodeImage } from './nodeCanvasGenerate'
import { adoptNodeResult, recordNodeOutput } from './nodeCanvasResults'
import { inpaintRefusal } from './submitInpaint'

export type ImageEditMode = 'inpaint' | 'annotate' | 'draw'
export type ImageEditStroke = MaskStroke & { color: string }
export interface NodeImageEditSource {
  nodeId: string
  fileId: string
  source: string
  mainId?: string
  element: ImageEl
  image: HTMLImageElement
}

export async function openNodeImageEdit(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  nodeId: string,
): Promise<NodeImageEditSource> {
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === nodeId)
  if (node?.type !== 'image' || !node.data.fileId)
    throw new Error(i18next.t('inpaint.sourceGone', { ns: 'canvas' }))
  const fileId = node.data.fileId
  const source = editor.doc.files[fileId]
  if (!source) throw new Error(i18next.t('inpaint.sourceGone', { ns: 'canvas' }))
  adoptNodeResult(canvas.doc, nodeId)
  const mainId = canvasMainResult(canvas.doc, nodeId)?.id
  const image = await loadImage(await resolveMediaSource(source, 'original', true))
  const result = {
    nodeId,
    fileId,
    source,
    mainId,
    image,
    element: {
      id: nodeId,
      type: 'image' as const,
      fileId,
      x: 0,
      y: 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
      rotation: 0,
    },
  }
  assertImageEditSource(editor, canvas, result)
  return result
}

export function assertImageEditSource(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  source: NodeImageEditSource,
): void {
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === source.nodeId)
  const main = canvasMainResult(canvas.doc, source.nodeId)
  const promoted =
    node?.type === 'image' && !!node.data.mediaId && main?.display?.mediaId === node.data.mediaId
  if (
    canvas.doc.isDestroyed ||
    node?.type !== 'image' ||
    (!promoted &&
      (node.data.fileId !== source.fileId || editor.doc.files[source.fileId] !== source.source)) ||
    canvasMainResult(canvas.doc, source.nodeId)?.id !== source.mainId
  ) {
    throw new Error(i18next.t('pixelEdit.sourceChanged', { ns: 'canvas' }))
  }
}

/** Only strokes from this isolated editor are rasterized. Canvas annotations are never read. */
export function renderImageEditStrokes(
  element: ImageEl,
  strokes: readonly ImageEditStroke[],
  mask: boolean,
  layer = document.createElement('canvas'),
  scale = 1,
): HTMLCanvasElement {
  const width = Math.max(1, Math.round(element.width * scale))
  const height = Math.max(1, Math.round(element.height * scale))
  if (layer.width !== width) layer.width = width
  if (layer.height !== height) layer.height = height
  const ctx = layer.getContext('2d')
  if (!ctx) throw new Error(i18next.t('canvas.unsupported', { ns: 'lib' }))
  ctx.clearRect(0, 0, layer.width, layer.height)
  for (const stroke of strokes)
    paintMaskStroke(ctx, element, layer, stroke, {
      inverted: true,
      color: mask ? '#b5db80' : stroke.color,
    })
  return layer
}

export async function finishNodeImageEdit(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  source: NodeImageEditSource,
  mode: ImageEditMode,
  strokes: readonly ImageEditStroke[],
  prompt: string,
): Promise<boolean> {
  assertImageEditSource(editor, canvas, source)
  if (!strokes.length) return false
  if (mode === 'inpaint') {
    const refusal = inpaintRefusal(source.element, source.element, useStore.getState().settings)
    if (refusal) throw new Error(refusal)
    const prepared = await prepareMaskTargetDataUrl(
      await resolveMediaSource(source.source, 'original', true),
    )
    const maskDataUrl = await exportMaskDataUrl(source.element, prepared, strokes)
    assertImageEditSource(editor, canvas, source)
    const currentRefusal = inpaintRefusal(source.element, prepared, useStore.getState().settings)
    if (currentRefusal) throw new Error(currentRefusal)
    return submitNodeImage(editor, canvas.doc, source.nodeId, prompt, [prepared.dataUrl], {
      maskDataUrl,
    })
  }
  const layer = renderImageEditStrokes(source.element, strokes, false)
  const output = document.createElement('canvas')
  output.width = layer.width
  output.height = layer.height
  const ctx = output.getContext('2d')
  if (!ctx) throw new Error(i18next.t('canvas.unsupported', { ns: 'lib' }))
  ctx.drawImage(source.image, 0, 0)
  ctx.drawImage(layer, 0, 0)
  const dataUrl = await blobDataUrl(await canvasToBlob(output))
  assertImageEditSource(editor, canvas, source)
  if (mode === 'annotate') {
    return submitNodeImage(
      editor,
      canvas.doc,
      source.nodeId,
      `请按照图中的手绘标注修改图片，输出干净图片，不保留标注线条；未标注的区域尽量保持原样。\n修改要求：${prompt}`,
      [dataUrl],
      {},
    )
  }
  const fileId = editor.doc.cacheBitmap(dataUrl)
  const result = await recordNodeOutput(
    canvas.doc,
    {
      nodeId: source.nodeId,
      kind: 'image',
      createdAt: Date.now(),
      source: { type: 'file', fileId },
    },
    dataUrl,
  )
  assertImageEditSource(editor, canvas, source)
  if (!result) return false
  adoptNodeResult(canvas.doc, source.nodeId)
  canvas.undo.stopCapturing()
  const selected = chooseCanvasResult(
    canvas.doc,
    source.nodeId,
    result.id,
    { data: { fileId, naturalWidth: output.width, naturalHeight: output.height } },
    canvas.origin,
  )
  canvas.undo.stopCapturing()
  return selected
}
