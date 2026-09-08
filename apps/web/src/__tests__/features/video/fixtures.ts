import type { DiscoveredChannel } from '@image-playground/shared'
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

export const VEO_FAST_MODEL = 'veo-3.1-fast-generate-preview'
export const VEO_LITE_MODEL = 'veo-3.1-lite-generate-preview'

export const VEO_CHANNEL: DiscoveredChannel = {
  id: 'veo-video',
  kind: 'openai-queue',
  label: 'Veo',
  models: [VEO_FAST_MODEL, VEO_LITE_MODEL].map((id) => ({
    id,
    label: id,
    capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
    media: 'video' as const,
  })),
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
