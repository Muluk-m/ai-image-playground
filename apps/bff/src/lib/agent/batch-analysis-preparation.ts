import { prepareAnalysisTask } from '../analysis-tasks'
import { jointAnalysisLimit } from './batch-analysis-limit'
import { BatchPlanError } from './batch-plans'
import { AgentContextOverflow } from './request-budget'
import { AgentToolError } from './tools/errors'

/** User-correctable preparation refusals retain the batch API's explicit refusal contract. */
export async function prepareBatchAnalysis(input: Parameters<typeof prepareAnalysisTask>[0]) {
  try {
    return await prepareAnalysisTask(input)
  } catch (error) {
    if (
      input.intent === 'joint_comparison' &&
      (error instanceof AgentContextOverflow ||
        (error instanceof AgentToolError && error.code === 'quota_exceeded'))
    )
      jointAnalysisLimit(
        error,
        input.inputs.map((one) => one.imageId),
      )
    if (error instanceof AgentContextOverflow) throw new BatchPlanError('context_overflow', 422)
    if (error instanceof AgentToolError) throw new BatchPlanError(error.code, 422)
    if (error instanceof Error) {
      switch (error.message) {
        case 'analysis_inputs_invalid':
        case 'analysis_output_budget_invalid':
        case 'analysis_visual_evidence_missing':
          throw new BatchPlanError(error.message, 422)
      }
    }
    throw error
  }
}
