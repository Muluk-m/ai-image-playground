import { PROJECT_ELEMENT_MAX_COUNT } from './project-protocol'

/**
 * 用户发话时浏览器里那张画布的目录。
 * 服务端项目文档只收已经换成云端媒体 id 的图，一张还在本地就会让整份文档推不上去；
 * 看画布和整理必须认这份，否则屏幕上的图对智能体是不存在的。
 */
export const AGENT_CANVAS_SNAPSHOT_MAX = PROJECT_ELEMENT_MAX_COUNT
const ID_MAX = 128
const NAME_MAX = 200
const TEXT_MAX = 80
const COORD_MAX = 10_000_000
const MEDIA_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export interface AgentCanvasLiveImage {
  readonly id: string
  readonly type: 'image'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly groupId?: string
  readonly createdAt?: number
  readonly prompt?: string
  readonly section?: string
  readonly mediaId?: string
  readonly video?: true
  readonly derivedFrom?: string
  /** 元素左上角相对外接矩形的偏移。旋转过的图，整理落点要加回这个偏移。 */
  readonly dx?: number
  readonly dy?: number
}

export interface AgentCanvasLiveBox {
  readonly id: string
  readonly type: 'text' | 'shape'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly text?: string
}

export type AgentCanvasLiveElement = AgentCanvasLiveImage | AgentCanvasLiveBox

export interface AgentCanvasSnapshot {
  readonly elements: readonly AgentCanvasLiveElement[]
  /** 目录装不下的其余元素个数。有它时，elements 不是用户看见的全部。 */
  readonly omitted?: number
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= COORD_MAX
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX ? value : undefined
}

function boxOf(
  value: Record<string, unknown>,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height))
    return undefined
  if (value.width < 0 || value.height < 0) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function elementOf(value: unknown): AgentCanvasLiveElement | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = idOf(record.id)
  const box = boxOf(record)
  if (!id || !box) return undefined
  if (record.type === 'image') {
    const createdAt =
      typeof record.createdAt === 'number' && Number.isSafeInteger(record.createdAt)
        ? record.createdAt
        : undefined
    return {
      id,
      type: 'image',
      ...box,
      ...(text(record.name, NAME_MAX) ? { name: text(record.name, NAME_MAX) } : {}),
      ...(text(record.groupId, ID_MAX) ? { groupId: text(record.groupId, ID_MAX) } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(text(record.prompt, TEXT_MAX) ? { prompt: text(record.prompt, TEXT_MAX) } : {}),
      ...(text(record.section, TEXT_MAX) ? { section: text(record.section, TEXT_MAX) } : {}),
      ...(typeof record.mediaId === 'string' && MEDIA_ID.test(record.mediaId)
        ? { mediaId: record.mediaId }
        : {}),
      ...(record.video === true ? { video: true } : {}),
      ...(idOf(record.derivedFrom) ? { derivedFrom: idOf(record.derivedFrom) } : {}),
      ...(finite(record.dx) ? { dx: record.dx } : {}),
      ...(finite(record.dy) ? { dy: record.dy } : {}),
    }
  }
  if (record.type === 'text' || record.type === 'shape') {
    return {
      id,
      type: record.type,
      ...box,
      ...(text(record.text, TEXT_MAX) ? { text: text(record.text, TEXT_MAX) } : {}),
    }
  }
  return undefined
}

/** 坏掉的条目丢掉，整份不像目录就当没带。调用方因此不会因为目录拒绝整轮对话。 */
export function parseAgentCanvasSnapshot(value: unknown): AgentCanvasSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const elements = (value as { elements?: unknown }).elements
  if (!Array.isArray(elements)) return undefined
  const reportedOmitted = (value as { omitted?: unknown }).omitted
  const omitted =
    typeof reportedOmitted === 'number' &&
    Number.isSafeInteger(reportedOmitted) &&
    reportedOmitted >= 0
      ? reportedOmitted
      : 0
  // 不能把截断的前半段当成完整画布；浏览器只会发送上限内的元素及 omitted。
  if (elements.length > AGENT_CANVAS_SNAPSHOT_MAX) return undefined
  if (elements.length === 0) return omitted ? { elements: [], omitted } : { elements: [] }
  const seen = new Set<string>()
  const parsed: AgentCanvasLiveElement[] = []
  for (const item of elements) {
    const element = elementOf(item)
    if (!element || seen.has(element.id)) continue
    seen.add(element.id)
    parsed.push(element)
  }
  if (parsed.length === 0) return undefined
  const missing = omitted + elements.length - parsed.length
  return missing > 0 ? { elements: parsed, omitted: missing } : { elements: parsed }
}
