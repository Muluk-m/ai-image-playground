import type { DiscoveredChannel, VideoModelSupport } from '@image-playground/shared'
import type { VideoTask } from '../../../features/video/types'

export const GROK_CHANNEL: DiscoveredChannel = {
  id: 'grok-video',
  kind: 'openai-queue',
  label: 'Grok 视频',
  models: [
    {
      id: 'grok-imagine-video',
      label: 'Grok Imagine Video',
      capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      media: 'video',
    },
  ],
  defaults: {},
}

export const AGNES_CHANNEL: DiscoveredChannel = {
  id: 'agnes-video',
  kind: 'openai-queue',
  label: 'Agnes 视频',
  models: [
    {
      id: 'agnes-video-2.5-flash',
      label: 'Agnes Video 2.5 Flash',
      capabilities: [
        'generate',
        'duration',
        'aspect_ratio',
        'resolution',
        'first_frame',
        'last_frame',
      ],
      media: 'video',
    },
  ],
  defaults: {},
}

/** 组合约束（某清晰度只配得上部分时长）要到 Veo 才有真模型，测试先自己登记一条。 */
export const CONSTRAINED_MODEL = 'constrained-video-test-model'

export const CONSTRAINED_SUPPORT: VideoModelSupport = {
  label: '受限模型',
  durations: [4, 6, 8],
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  resolutionMultipliers: { '720p': 1, '1080p': 1.2 },
  durationsByResolution: { '1080p': [8] },
  firstFrame: true,
  lastFrame: false,
  extend: false,
  edit: false,
  typicalSeconds: 60,
  tagline: '受限',
}

export const CONSTRAINED_CHANNEL: DiscoveredChannel = {
  id: 'constrained-video',
  kind: 'openai-queue',
  label: '受限视频',
  models: [
    {
      id: CONSTRAINED_MODEL,
      label: '受限模型',
      capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      media: 'video',
    },
  ],
  defaults: {},
}

export const IMAGE_CHANNEL: DiscoveredChannel = {
  id: 'openai',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [{ id: 'gpt-image-2', label: 'gpt-image-2', capabilities: ['generate'] }],
  defaults: {},
}

export function videoTask(overrides: Partial<VideoTask> = {}): VideoTask {
  return {
    id: 'task-1',
    clientRequestId: 'client-1',
    channelId: 'grok-video',
    source: 'text',
    prompt: '霓虹街道跑车驶过',
    model: 'grok-imagine-video',
    duration: 5,
    aspectRatio: '16:9',
    resolution: '720p',
    status: 'done',
    error: null,
    createdAt: 1_000,
    completedAt: 40_000,
    bffRequestId: 'req-1',
    outputIndex: 0,
    ...overrides,
  }
}
