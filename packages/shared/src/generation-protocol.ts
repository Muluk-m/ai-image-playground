import type { SubmitRequest, TaskStatus } from './queue-protocol'

export interface GenerationSummary {
  cover: GenerationImage | null
  id: string
  provider: string
  model: string
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  revision: string
}

export interface GenerationImage {
  index: number
  mediaId: string
  width: number | null
  height: number | null
  contentType: string
}

export type GenerationParameters = Pick<
  SubmitRequest,
  | 'size'
  | 'quality'
  | 'output_format'
  | 'output_compression'
  | 'moderation'
  | 'aspect_ratio'
  | 'image_size'
  | 'thinking_level'
  | 'n'
>

export interface GenerationDetail extends GenerationSummary {
  inputs: GenerationImage[]
  mask: GenerationImage | null
  parameters: GenerationParameters
  actualParameters: Pick<GenerationParameters, 'size' | 'quality' | 'output_format'>
  outputs: GenerationImage[]
  prompt: string
}

export interface GenerationPage {
  items: GenerationSummary[]
  nextCursor: string | null
}
