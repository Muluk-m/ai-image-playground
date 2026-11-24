import { eq } from 'drizzle-orm'
import { schema } from '../../db/client'
import {
  type AgentJobSettlementTarget,
  agentJobViews,
  cancelAgentConversationJobsWith,
  cancelAgentJob,
  cancelStoppedTurnJobs,
  clearAgentWakeSkippedForWakes,
  markAgentJobsWakeSkipped,
  projectSettledAgentJobs,
  settleAgentJobs,
  settleAgentJobsForTasks,
  settledJobBlock,
  settleSubmittedTaskIfTerminal,
} from '../../modules/agent'
import type { ExternalExecutionTransaction } from '../../modules/execution'
import { cancelAnalysisTasks } from '../analysis-tasks'

export {
  type AgentJobSettlementTarget,
  agentJobViews,
  cancelAgentJob,
  cancelStoppedTurnJobs,
  clearAgentWakeSkippedForWakes,
  markAgentJobsWakeSkipped,
  projectSettledAgentJobs,
  settleAgentJobs,
  settleAgentJobsForTasks,
  settledJobBlock,
  settleSubmittedTaskIfTerminal,
}

/** 绑定分析任务取消器后的会话任务取消入口，保持 `conversation/` 不反向依赖 `analysis-tasks.ts`。 */
export function cancelAgentConversationJobs(
  conversationId: string,
  external?: ExternalExecutionTransaction,
): Promise<number> {
  return cancelAgentConversationJobsWith(
    conversationId,
    (id, tx) => cancelAnalysisTasks(eq(schema.tasks.agent_conversation_id, id), tx),
    external,
  )
}
