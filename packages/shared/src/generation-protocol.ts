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

export interface GenerationDetail extends GenerationSummary {
  prompt: string
}

export interface GenerationPage {
  items: GenerationSummary[]
  nextCursor: string | null
}
