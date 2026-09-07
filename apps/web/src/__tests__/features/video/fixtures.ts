import type { DiscoveredChannel } from '@image-playground/shared'

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
      id: 'agnes-video-2.5',
      label: 'Agnes Video 2.5',
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

export const IMAGE_CHANNEL: DiscoveredChannel = {
  id: 'openai',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [{ id: 'gpt-image-2', label: 'gpt-image-2', capabilities: ['generate'] }],
  defaults: {},
}
