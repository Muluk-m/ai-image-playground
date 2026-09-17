import type { TaskStatus } from './queue-protocol'

export interface GenerationSummary {
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

export interface GenerationDetail extends GenerationSummary {
  outputs: GenerationImage[]
  prompt: string
}

export interface GenerationPage {
  items: GenerationSummary[]
  nextCursor: string | null
}
