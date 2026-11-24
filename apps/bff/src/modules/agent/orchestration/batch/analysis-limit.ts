import { AgentContextOverflow } from '../../../../lib/agent/request-budget'
import { AgentToolError, BatchAnalysisLimit } from '../../contracts'

export { BatchAnalysisLimit }

export function jointAnalysisLimit(error: unknown, imageIds: readonly string[]): never {
  if (error instanceof AgentContextOverflow)
    throw new BatchAnalysisLimit(error, imageIds, 'context_overflow')
  if (error instanceof AgentToolError && error.code === 'quota_exceeded')
    throw new BatchAnalysisLimit(error, imageIds, 'visual_limit')
  throw error
}
