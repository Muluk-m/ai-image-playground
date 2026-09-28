import type { AgentCanvasLiveElement, AgentCanvasSnapshot } from '@image-playground/shared'
import { AGENT_CANVAS_SNAPSHOT_MAX } from '@image-playground/shared'
import type { CanvasDoc, CanvasEl, ImageEl } from './canvasDoc'
import { elementBounds } from './editor'

const PROMPT_CHARS = 80
const MEDIA_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function imageOf(element: ImageEl): AgentCanvasLiveElement {
  const prompt = clip(element.meta?.userPrompt || element.meta?.prompt, PROMPT_CHARS)
  const section = clip(element.meta?.section, PROMPT_CHARS)
  const name = clip(element.name, 200)
  const derived = element.video?.generation?.derivedFrom?.id
  return {
    id: element.id,
    type: 'image',
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    ...(name ? { name } : {}),
    ...(element.groupId ? { groupId: element.groupId } : {}),
    ...(element.createdAt !== undefined ? { createdAt: element.createdAt } : {}),
    ...(prompt ? { prompt } : {}),
    ...(section ? { section } : {}),
    ...(MEDIA_ID.test(element.fileId) ? { mediaId: element.fileId } : {}),
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

/** 发话这一刻的画布。空画布不附，避免用一份空目录盖掉服务端还有内容的旧项目。 */
export function liveCanvasSnapshot(doc: CanvasDoc | undefined): AgentCanvasSnapshot | undefined {
  if (!doc) return undefined
  const elements = doc.elements.flatMap((element) => {
    if (element.type === 'image') return [imageOf(element)]
    const box = boxOf(element)
    return box ? [box] : []
  })
  if (elements.length === 0) return undefined
  return { elements: elements.slice(0, AGENT_CANVAS_SNAPSHOT_MAX) }
}
