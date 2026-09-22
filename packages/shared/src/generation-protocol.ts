import type { SubmitRequest, TaskErrorType, TaskStatus } from './queue-protocol'

export type GenerationSource =
  | { kind: 'studio' }
  | { kind: 'agent'; conversationId: string; turnId: string; projectId: string | null }

export interface GenerationSummary {
  /** 缺席或 null 表示历史版本未保留来源，不猜测为普通生成。 */
  source?: GenerationSource | null
  archiveStatus: 'none' | 'pending' | 'ready' | 'unavailable'
  errorType: TaskErrorType | null
  cover: GenerationImage | null
  /**
   * 生成时用的参考图与遮罩。跟着列表一起给，是因为「复用配置」要的就是这些：
   * 提示词、参数、模型都已经在条目里，再为这两样单独读一次详情，用户点下去就先等一个来回。
   * 产出原件仍然只在详情里——那是一整页卡片都用不上的东西。
   */
  inputs: readonly GenerationImage[]
  mask: GenerationImage | null
  id: string
  provider: string
  model: string
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  revision: string
  prompt: string
  parameters: GenerationParameters
  actualParameters: Pick<GenerationParameters, 'size' | 'quality' | 'output_format'>
}

export interface GenerationImage {
  /** 仅输出具有稳定画布身份；旧响应可缺席。 */
  artifactId?: string
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
  outputs: readonly GenerationImage[]
}

export interface GenerationPage {
  items: GenerationSummary[]
  nextCursor: string | null
}
