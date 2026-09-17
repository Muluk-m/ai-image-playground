import type {
  VideoAspectRatio,
  VideoDeriveMode,
  VideoDuration,
  VideoResolution,
} from '@image-playground/shared'

import { i18next } from '../../i18n'
import type { StoryboardVersion } from './storyboard/types'

export const VIDEO_SOURCES = ['text', 'image'] as const
export type VideoSource = (typeof VIDEO_SOURCES)[number]

export function videoSourceLabels(): Record<VideoSource, string> {
  return {
    text: i18next.t('source.text', { ns: 'video' }),
    image: i18next.t('source.image', { ns: 'video' }),
  }
}

/** 左栏的第三格只是页签：分镜自己出图，出的视频仍记成图生。 */
export const VIDEO_COMPOSER_SOURCES = [...VIDEO_SOURCES, 'storyboard'] as const
export type VideoComposerSource = (typeof VIDEO_COMPOSER_SOURCES)[number]

export function videoComposerSourceLabels(): Record<VideoComposerSource, string> {
  return {
    ...videoSourceLabels(),
    storyboard: i18next.t('source.storyboard', { ns: 'video' }),
  }
}

export const VIDEO_FRAME_SLOTS = ['first', 'last'] as const
export type VideoFrameSlot = (typeof VIDEO_FRAME_SLOTS)[number]

export function videoFrameSlotLabel(slot: VideoFrameSlot): string {
  return slot === 'first'
    ? i18next.t('frameSlot.first', { ns: 'video' })
    : i18next.t('frameSlot.last', { ns: 'video' })
}

export type VideoTaskStatus = 'queued' | 'running' | 'done' | 'error'

export function videoTaskStatusLabel(status: VideoTaskStatus): string {
  if (status === 'queued') return i18next.t('status.queued', { ns: 'video' })
  if (status === 'running') return i18next.t('state.generating', { ns: 'common' })
  if (status === 'done') return i18next.t('state.done', { ns: 'common' })
  return i18next.t('state.failed', { ns: 'common' })
}

/** 一条视频任务。mp4 不进这里 —— 播放地址由 bffRequestId 与 outputIndex 拼出来。 */
export interface VideoTask {
  id: string
  /** BFF 队列的 request_id，刷新后续轮与播放地址都用它。 */
  bffRequestId?: string
  /** 幂等键。提交中刷新时带同一个重提，BFF 去重。 */
  clientRequestId: string
  /** 提交到哪条频道，重生成与续提交要它。 */
  channelId: string
  source: VideoSource
  prompt: string
  model: string
  /** generate 走档位表；续写填的是续写秒数，不一定落在档位上。 */
  duration: number
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId?: string
  lastFrameImageId?: string
  /** 缺席即普通生成。sourceTaskId 是本地任务 id，提交时才换成源片的 bffRequestId。 */
  derived?: { mode: VideoDeriveMode; sourceTaskId: string }
  status: VideoTaskStatus
  error: string | null
  /** 提交前的估算积分，无计费时不写。 */
  credits?: number
  /** 完成时的输出下标；播放地址是 `/v1/queue/requests/{bffRequestId}/output/{outputIndex}`。 */
  outputIndex?: number
  /** 实际输出像素，完成时由队列输出元信息回填；上游不给就没有。 */
  width?: number
  height?: number
  createdAt: number
  completedAt: number | null
  /** 图生任务是首帧缩略图；文生任务由播放器首帧截图回填。 */
  thumbnailDataUrl?: string
  /** 由分镜的某一镜提交时带上，卡片据此标镜号。 */
  storyboardVersion?: StoryboardVersion
  storyboardId?: string
  shotNo?: number
}

/** 左栏这一刻的参数。提交时冻结成 VideoTask。 */
export interface VideoDraft {
  source: VideoSource
  prompt: string
  model: string
  duration: VideoDuration
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId: string | null
  lastFrameImageId: string | null
}

/**
 * 点一下把文字追加到描述末尾，用户看得见它只是提示词。追加的是初值文案：
 * 按点下去那一刻的界面语言写，写完就是用户描述里的普通文字。
 */
export const CAMERA_MOVE_KEYS = [
  'cameraMove.slowPush',
  'cameraMove.halfOrbit',
  'cameraMove.handheldFollow',
  'cameraMove.flowingLight',
  'cameraMove.subtleStill',
] as const
