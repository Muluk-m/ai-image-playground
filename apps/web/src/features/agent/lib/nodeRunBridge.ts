import type { AgentCanvasRunProposal, StageAuthorizationSubmission } from '@image-playground/shared'
import type { NodeBatchHooks, NodeBatchPlan } from '../../canvas/lib/nodeBatch'

interface AgentNodeBatchExecution {
  readonly signal: AbortSignal
  readonly progress: (completed: number, id: string) => void
  readonly authorizations: Readonly<Record<string, StageAuthorizationSubmission>>
  readonly hooks: NodeBatchHooks
}

/** Mounted node canvas only. Receiving/replaying a proposal never runs it by itself. */
export interface AgentNodeRunBridge {
  readonly projectId: string
  quote(proposal: AgentCanvasRunProposal): NodeBatchPlan | null
  run(
    proposal: AgentCanvasRunProposal,
    plan: NodeBatchPlan,
    execution: AgentNodeBatchExecution,
  ): Promise<void>
}
let current: AgentNodeRunBridge | null = null
const listeners = new Set<() => void>()
export const agentNodeRunBridge = () => current
export function subscribeAgentNodeRun(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function registerAgentNodeRun(bridge: AgentNodeRunBridge) {
  current = bridge
  for (const listener of listeners) listener()
  return () => {
    if (current !== bridge) return
    current = null
    for (const listener of listeners) listener()
  }
}
