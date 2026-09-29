import type { AgentCanvasLiveElement, AgentCanvasSnapshot } from '@image-playground/shared'
import { AGENT_CANVAS_SNAPSHOT_MAX } from '@image-playground/shared'
import { mediaIdentity } from '../../../lib/cloudMedia'
import type { CanvasDoc, CanvasEl, ImageEl } from './canvasDoc'
import { elementBounds } from './editor'

const PROMPT_CHARS = 80

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function imageOf(
  element: ImageEl,
  source: string | undefined,
  mediaIdFor?: (fileId: string, source: string | undefined) => string | undefined,
): AgentCanvasLiveElement {
  const prompt = clip(element.meta?.userPrompt || element.meta?.prompt, PROMPT_CHARS)
  const section = clip(element.meta?.section, PROMPT_CHARS)
  const name = clip(element.name, 200)
  const derived = element.video?.generation?.derivedFrom?.id
  const mediaId = mediaIdFor?.(element.fileId, source) ?? mediaIdentity(source)
  const bounds = elementBounds(element)
  const dx = element.x - bounds.x
  const dy = element.y - bounds.y
  return {
    id: element.id,
    type: 'image',
    x: bounds.x,
    y: bounds.y,
    width: bounds.w,
    height: bounds.h,
    ...(dx !== 0 ? { dx } : {}),
    ...(dy !== 0 ? { dy } : {}),
    ...(name ? { name } : {}),
    ...(element.groupId ? { groupId: element.groupId } : {}),
    ...(element.createdAt !== undefined ? { createdAt: element.createdAt } : {}),
    ...(prompt ? { prompt } : {}),
    ...(section ? { section } : {}),
    ...(mediaId ? { mediaId } : {}),
    ...(element.video ? { video: true } : {}),
    ...(derived ? { derivedFrom: derived } : {}),
  }
}

function boxOf(element: CanvasEl): AgentCanvasLiveElement | undefined {
  const box = elementBounds(element)
  if (element.type === 'text') {
    return {
      id: element.id,
      type: 'text',
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      ...(clip(element.text, PROMPT_CHARS) ? { text: clip(element.text, PROMPT_CHARS) } : {}),
    }
  }
  if (box.w <= 0 && box.h <= 0) return undefined
  return { id: element.id, type: 'shape', x: box.x, y: box.y, width: box.w, height: box.h }
}

/**
 * 发话这一刻的画布。没有打开的文档返回 undefined（服务端再去读已同步的那份）；
 * 打开了但被清空则是空目录，不能再退回旧的云端文档。
 */
export function liveCanvasSnapshot(
  doc: CanvasDoc | undefined,
  mediaIdFor?: (fileId: string, source: string | undefined) => string | undefined,
): AgentCanvasSnapshot | undefined {
  if (!doc) return undefined
  const elements = doc.elements.flatMap((element) => {
    if (element.type === 'image') return [imageOf(element, doc.files[element.fileId], mediaIdFor)]
    const box = boxOf(element)
    return box ? [box] : []
  })
  const shown = elements.slice(0, AGENT_CANVAS_SNAPSHOT_MAX)
  const omitted = elements.length - shown.length
  return omitted > 0 ? { elements: shown, omitted } : { elements: shown }
}
