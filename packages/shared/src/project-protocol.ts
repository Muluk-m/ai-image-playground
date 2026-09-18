import { AGENT_IMAGE_MAX_N, type AgentToolErrorCode, isAgentToolErrorCode } from './agent'
import { isVideoGenerationRecord, type VideoGenerationRecord } from './video-generation'

export const PROJECT_NAME_MAX_LENGTH = 120
export const PROJECT_PAGE_SIZE = 30
export const PROJECT_PAGE_MAX_SIZE = 100
export const PROJECT_DOCUMENT_MAX_BYTES = 512 * 1024
export const PROJECT_ELEMENT_MAX_COUNT = 1000
export const PROJECT_RECEIPT_COUNT = 128
/** 元素 meta 单个值的最长字符数。 */
export const PROJECT_META_VALUE_MAX_CHARS = 10000

export interface ProjectImage {
  id: string
  type: 'image'
  mediaId: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  name?: string
  naturalWidth?: number
  naturalHeight?: number
  createdAt?: number
  groupId?: string
  meta?: Record<string, string>
  /** 有值即 `mediaId` 只是封面，片子在队列里；播放地址由客户端现拼，不存整条 URL。 */
  video?: ProjectVideoRef
}

export interface ProjectVideoRef {
  taskId: string
  outputIndex: number
  generation?: VideoGenerationRecord
}

/** 视频输出的上限与队列一致；超出的下标只可能是坏数据。 */
const PROJECT_VIDEO_OUTPUT_MAX = 16

function videoRef(value: unknown): boolean {
  if (!object(value) || !keys(value, ['taskId', 'outputIndex', 'generation'])) return false
  return (
    typeof value.taskId === 'string' &&
    // 它会被拼进播放地址的路径段，只放行 id 字符。
    /^[A-Za-z0-9_-]{1,128}$/.test(value.taskId) &&
    typeof value.outputIndex === 'number' &&
    Number.isSafeInteger(value.outputIndex) &&
    value.outputIndex >= 0 &&
    value.outputIndex < PROJECT_VIDEO_OUTPUT_MAX &&
    (value.generation === undefined || isVideoGenerationRecord(value.generation))
  )
}

export interface ProjectGeneration {
  id: string
  type: 'generation'
  generationId: string
  position: number
  x: number
  y: number
  width: number
  height: number
  /**
   * 有值即这个预留位置的生成失败了：它作为失败占位留在画布上、跨设备可见，界面按码给出路
   * （ADR 0006）。只由服务端在任务终态时写；缺席即仍在生成中。
   */
  errorCode?: AgentToolErrorCode
}

export function projectArtifactId(generationId: string, position: number): string {
  return `agent_${generationId}_${position}`
}

/** {@link projectArtifactId} 的反面：认不出的 id 给 null。 */
export function parseProjectArtifactId(
  id: string,
): { readonly generationId: string; readonly position: number } | null {
  const match = /^agent_([A-Za-z0-9_-]+)_(\d+)$/.exec(id)
  return match ? { generationId: match[1]!, position: Number(match[2]) } : null
}

export type ProjectElement =
  | ProjectGeneration
  | ProjectImage
  | {
      id: string
      type: 'text'
      x: number
      y: number
      text: string
      fontSize: number
      fill: string
      width: number
      height: number
    }
  | {
      id: string
      type: 'arrow'
      points: [number, number, number, number]
      stroke: string
      strokeWidth: number
    }
  | { id: string; type: 'freedraw'; points: number[]; stroke: string; strokeWidth: number }
  | ProjectTimeline

/** 时间线只存对同一项目里视频元素的有序引用与入出点（秒），不存媒体。 */
export interface ProjectTimeline {
  id: string
  type: 'timeline'
  x: number
  y: number
  width: number
  height: number
  clips: { elementId: string; in: number; out?: number }[]
}

export const PROJECT_TIMELINE_MAX_CLIPS = 64
/** 单段入出点的上限（秒）。上游最长的片子也远不到它，超出只可能是坏数据。 */
const PROJECT_CLIP_MAX_SECONDS = 3600

function timelineClip(value: unknown): boolean {
  if (!object(value) || !keys(value, ['elementId', 'in', 'out'])) return false
  const within = (seconds: unknown) =>
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    seconds <= PROJECT_CLIP_MAX_SECONDS
  return (
    typeof value.elementId === 'string' &&
    value.elementId.length > 0 &&
    value.elementId.length <= 128 &&
    within(value.in) &&
    (value.out === undefined || (within(value.out) && (value.out as number) > (value.in as number)))
  )
}

/** 云端结构不包含位图、相机、选区或撤销历史。 */
export interface ProjectDocument {
  version: 1
  elements: ProjectElement[]
}

export interface CloudProjectSummary {
  id: string
  name: string
  revision: number
  createdAt: number
  updatedAt: number
  elementCount: number
  coverMediaId?: string | null
  conversationId?: string | null
}
export interface RecycledProject extends CloudProjectSummary {
  deletedAt: number
  restoreUntil: number
}
export interface ProjectTrashPage {
  projects: RecycledProject[]
  nextCursor: string | null
}
export interface CloudProject extends CloudProjectSummary {
  document: ProjectDocument
}
export interface ProjectWrite {
  requestId: string
  baseRevision: number
  name: string
  document: ProjectDocument
}
export interface ProjectPage {
  deletedIds?: string[]
  projects: CloudProjectSummary[]
  nextCursor: string | null
}
export interface ProjectReceipt {
  requestId: string
  digest: string
  result: CloudProjectSummary
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000
}
function size(value: unknown): boolean {
  return coordinate(value) && value >= 0
}
function color(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)
}
function element(value: unknown): value is ProjectElement {
  if (!object(value) || typeof value.id !== 'string' || !value.id.length || value.id.length > 128)
    return false
  if (value.type === 'generation') {
    return (
      keys(value, [
        'id',
        'type',
        'generationId',
        'position',
        'x',
        'y',
        'width',
        'height',
        'errorCode',
      ]) &&
      (value.errorCode === undefined || isAgentToolErrorCode(value.errorCode)) &&
      typeof value.generationId === 'string' &&
      value.generationId.length <= 128 &&
      typeof value.position === 'number' &&
      Number.isSafeInteger(value.position) &&
      value.position >= 0 &&
      value.position < AGENT_IMAGE_MAX_N &&
      value.id === projectArtifactId(value.generationId, value.position) &&
      coordinate(value.x) &&
      coordinate(value.y) &&
      size(value.width) &&
      size(value.height)
    )
  }
  if (value.type === 'image') {
    return (
      keys(value, [
        'id',
        'type',
        'mediaId',
        'x',
        'y',
        'width',
        'height',
        'rotation',
        'name',
        'naturalWidth',
        'naturalHeight',
        'createdAt',
        'groupId',
        'meta',
        'video',
      ]) &&
      (value.video === undefined || videoRef(value.video)) &&
      typeof value.mediaId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.mediaId) &&
      coordinate(value.x) &&
      coordinate(value.y) &&
      size(value.width) &&
      size(value.height) &&
      coordinate(value.rotation) &&
      (value.name === undefined || (typeof value.name === 'string' && value.name.length <= 500)) &&
      (value.groupId === undefined ||
        (typeof value.groupId === 'string' && value.groupId.length <= 128)) &&
      (value.naturalWidth === undefined || size(value.naturalWidth)) &&
      (value.naturalHeight === undefined || size(value.naturalHeight)) &&
      (value.createdAt === undefined ||
        (typeof value.createdAt === 'number' &&
          Number.isSafeInteger(value.createdAt) &&
          value.createdAt >= 0)) &&
      (value.meta === undefined ||
        (object(value.meta) &&
          Object.keys(value.meta).length <= 32 &&
          Object.entries(value.meta).every(
            ([key, content]) =>
              key.length <= 128 &&
              typeof content === 'string' &&
              content.length <= PROJECT_META_VALUE_MAX_CHARS,
          )))
    )
  }
  if (value.type === 'text') {
    return (
      keys(value, ['id', 'type', 'x', 'y', 'text', 'fontSize', 'fill', 'width', 'height']) &&
      coordinate(value.x) &&
      coordinate(value.y) &&
      size(value.width) &&
      size(value.height) &&
      coordinate(value.fontSize) &&
      value.fontSize > 0 &&
      value.fontSize <= 4096 &&
      color(value.fill) &&
      typeof value.text === 'string' &&
      value.text.length <= 10000
    )
  }
  if (value.type === 'timeline') {
    return (
      keys(value, ['id', 'type', 'x', 'y', 'width', 'height', 'clips']) &&
      coordinate(value.x) &&
      coordinate(value.y) &&
      size(value.width) &&
      size(value.height) &&
      Array.isArray(value.clips) &&
      value.clips.length <= PROJECT_TIMELINE_MAX_CLIPS &&
      value.clips.every(timelineClip)
    )
  }
  if (value.type === 'arrow' || value.type === 'freedraw') {
    return (
      keys(value, ['id', 'type', 'points', 'stroke', 'strokeWidth']) &&
      color(value.stroke) &&
      coordinate(value.strokeWidth) &&
      value.strokeWidth > 0 &&
      value.strokeWidth <= 1000 &&
      Array.isArray(value.points) &&
      value.points.length >= (value.type === 'arrow' ? 4 : 2) &&
      value.points.length % 2 === 0 &&
      value.points.length <= (value.type === 'arrow' ? 4 : 20000) &&
      value.points.every(coordinate)
    )
  }
  return false
}
export function isProjectDocument(value: unknown): value is ProjectDocument {
  return (
    object(value) &&
    keys(value, ['version', 'elements']) &&
    value.version === 1 &&
    Array.isArray(value.elements) &&
    value.elements.length <= PROJECT_ELEMENT_MAX_COUNT &&
    value.elements.every(element) &&
    new Set(value.elements.map((one) => one.id)).size === value.elements.length
  )
}
export function isProjectWrite(value: unknown): value is ProjectWrite {
  return (
    object(value) &&
    keys(value, ['requestId', 'baseRevision', 'name', 'document']) &&
    typeof value.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) &&
    typeof value.baseRevision === 'number' &&
    Number.isInteger(value.baseRevision) &&
    value.baseRevision >= 0 &&
    value.baseRevision < 2147483647 &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= PROJECT_NAME_MAX_LENGTH &&
    isProjectDocument(value.document)
  )
}
