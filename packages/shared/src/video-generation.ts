import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DERIVE_MODES,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDeriveMode,
  type VideoResolution,
} from './video-presets'

/**
 * 一段视频实际是按什么生成的。它跟着产物走到画布：「改一个参数重来」、续写、云同步都读它。
 * 首尾帧与派生源引用的是画布对象 id，不是任务 id。早于它的产物没有这一段，读的人按「未知」处理。
 */
export interface VideoGenerationRecord {
  readonly model: string
  /** 秒。续写记的是续写秒数，不一定落在生成的档位表上。 */
  readonly duration: number
  readonly aspectRatio: VideoAspectRatio
  readonly resolution: VideoResolution
  readonly firstFrameId?: string
  readonly lastFrameId?: string
  readonly derivedFrom?: { readonly id: string; readonly mode: VideoDeriveMode }
}

export type VideoGenerationSource = 'text' | 'image' | 'derived'

export function videoGenerationSource(record: VideoGenerationRecord): VideoGenerationSource {
  if (record.derivedFrom) return 'derived'
  return record.firstFrameId || record.lastFrameId ? 'image' : 'text'
}

const KEYS = new Set([
  'model',
  'duration',
  'aspectRatio',
  'resolution',
  'firstFrameId',
  'lastFrameId',
  'derivedFrom',
])

function objectId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

export function isVideoGenerationRecord(value: unknown): value is VideoGenerationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every((key) => KEYS.has(key))) return false
  if (typeof record.model !== 'string' || !record.model || record.model.length > 128) return false
  if (typeof record.duration !== 'number' || !Number.isFinite(record.duration)) return false
  if (record.duration <= 0 || record.duration > 600) return false
  if (!(VIDEO_ASPECT_RATIOS as readonly unknown[]).includes(record.aspectRatio)) return false
  if (!(VIDEO_RESOLUTIONS as readonly unknown[]).includes(record.resolution)) return false
  if (record.firstFrameId !== undefined && !objectId(record.firstFrameId)) return false
  if (record.lastFrameId !== undefined && !objectId(record.lastFrameId)) return false
  if (record.derivedFrom !== undefined) {
    const derived = record.derivedFrom
    if (typeof derived !== 'object' || derived === null) return false
    const { id, mode, ...rest } = derived as Record<string, unknown>
    if (Object.keys(rest).length > 0 || !objectId(id)) return false
    if (!(VIDEO_DERIVE_MODES as readonly unknown[]).includes(mode)) return false
  }
  return true
}
