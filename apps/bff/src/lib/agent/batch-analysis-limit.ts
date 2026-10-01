import type { AgentBatchAnalysisLimit } from '@image-playground/shared'
import { AgentContextOverflow } from './request-budget'
import { AgentToolError } from './tools/errors'

export class BatchAnalysisLimit extends Error {
  readonly details: AgentBatchAnalysisLimit
  constructor(error: AgentContextOverflow | AgentToolError, imageIds: readonly string[]) {
    super(
      '尚未完成联合比较。当前共同查看范围超出限制，请选择减少共同查看的图片，或指定必要区域；逐图摘要不能代替完整联合比较。',
      { cause: error },
    )
    this.name = 'BatchAnalysisLimit'
    this.details = {
      reason: error instanceof AgentContextOverflow ? 'context_overflow' : 'visual_limit',
      requiredImageIds: [...imageIds],
      jointComparisonCompleted: false,
      choices: ['select_images', 'select_regions'],
    }
  }
}

export function jointAnalysisLimit(error: unknown, imageIds: readonly string[]): never {
  if (
    error instanceof AgentContextOverflow ||
    (error instanceof AgentToolError && error.code === 'quota_exceeded')
  )
    throw new BatchAnalysisLimit(error, imageIds)
  throw error
}
