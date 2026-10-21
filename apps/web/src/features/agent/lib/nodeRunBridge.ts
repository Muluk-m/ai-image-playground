import type { AgentCanvasRunProposal } from '@image-playground/shared'
import type { NodeBatchPlan } from '../../canvas/lib/nodeBatch'

/** Mounted node canvas only. Receiving/replaying a proposal never runs it by itself. */
export interface AgentNodeRunBridge {
  readonly projectId: string
  quote(proposal: AgentCanvasRunProposal): NodeBatchPlan | null
  /** Rejects with `NodeBatchFailure` when the quoted signature no longer matches the canvas. */
  run(
    proposal: AgentCanvasRunProposal,
    signature: string,
    signal: AbortSignal,
    progress: (completed: number, id: string) => void,
    executionToken: string,
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
