import type { StageAuthorizationSubmission } from '@image-playground/shared'
import {
  type AgentCanvasRunProposal,
  readCanvasDocument,
  stageExecutionSpecsMatch,
} from '@image-playground/shared'
import { useEffect } from 'react'
import { useStore } from '../../../store'
import { registerAgentNodeRun } from '../../agent/lib/nodeRunBridge'
import { stageAuthorizationClient } from '../../agent/lib/stageAuthorizationClient'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from './editor'
import { billedNodeQuantity, currentNodeBatch, NodeBatchFailure, runNodeBatch } from './nodeBatch'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export function useAgentNodeRun({
  canvas,
  editor,
  projectId,
  active,
  revision,
  files,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  projectId?: string
  active: boolean
  revision: unknown
  files: unknown
}) {
  const settings = useStore((state) => state.settings)
  const params = useStore((state) => state.params)
  const draft = useVideoStore((state) => state.draft)
  useEffect(() => {
    if (!active || !projectId) return
    const quote = (proposal: AgentCanvasRunProposal) => {
      if (proposal.projectId !== projectId) return null
      const graph = readCanvasDocument(canvas.doc)
      const existing = new Set([
        ...graph.nodes.map((node) => node.id),
        ...(graph.groups ?? []).map((group) => group.id),
      ])
      if (!proposal.nodeIds.length || proposal.nodeIds.some((id) => !existing.has(id))) return null
      const plan = currentNodeBatch(canvas.doc, editor, proposal.nodeIds)
      // 临时上传不在服务端快照里。确认前就停住并提示，不能拖到提交才因张数对不上失败。
      if (plan.jobs.some((job) => Object.keys(job.temporary).length > 0))
        return { ...plan, error: 'local' as const }
      if (!proposal.specs?.length || plan.error) return plan
      const live = plan.jobs.map((job) => ({
        nodeId: job.id,
        model: job.model,
        quantity: billedNodeQuantity(job),
        unitMultiplier: job.unitMultiplier ?? 1,
      }))
      return stageExecutionSpecsMatch(live, proposal.specs)
        ? plan
        : { ...plan, error: 'stale' as const }
    }
    return registerAgentNodeRun({
      projectId,
      quote,
      run: async (proposal, signature, signal, progress, executionToken) => {
        const plan = quote(proposal)
        if (!plan || plan.signature !== signature || plan.error || plan.blocked)
          throw new NodeBatchFailure(plan?.error ?? 'changed')
        if (!proposal.authorizationId) throw new NodeBatchFailure('authorization')
        const authorizationId = proposal.authorizationId
        const authorizations: Record<string, StageAuthorizationSubmission> = {}
        for (const job of plan.jobs) {
          if (signal.aborted) throw new NodeBatchFailure('cancelled')
          const attemptId = crypto.randomUUID()
          await stageAuthorizationClient.preflight(authorizationId, {
            executionToken,
            attemptId,
            nodeId: job.id,
            model: job.model,
            quantity: billedNodeQuantity(job),
            unitMultiplier: job.unitMultiplier ?? 1,
          })
          authorizations[job.id] = {
            authorizationId,
            nodeId: job.id,
            attemptId,
            executionToken,
          }
        }
        if (signal.aborted) throw new NodeBatchFailure('cancelled')
        await runNodeBatch(
          canvas.doc,
          editor,
          proposal.nodeIds,
          plan,
          signal,
          progress,
          authorizations,
        )
      },
    })
  }, [active, projectId, canvas, editor, revision, files, settings, params, draft])
}
