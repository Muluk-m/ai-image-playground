import { type AgentCanvasRunProposal, readCanvasDocument } from '@image-playground/shared'
import { useEffect, useRef } from 'react'
import { useStore } from '../../../store'
import { registerAgentNodeRun } from '../../agent/lib/nodeRunBridge'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from './editor'
import { currentNodeBatch, type NodeBatchPlan } from './nodeBatch'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export function useAgentNodeRun({
  canvas,
  editor,
  projectId,
  active,
  revision,
  files,
  review,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  projectId?: string
  active: boolean
  revision: unknown
  files: unknown
  review: (ids: string[], plan: NodeBatchPlan) => boolean
}) {
  const settings = useStore((state) => state.settings)
  const params = useStore((state) => state.params)
  const draft = useVideoStore((state) => state.draft)
  const reviewRef = useRef(review)
  reviewRef.current = review
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
      return currentNodeBatch(canvas.doc, editor, proposal.nodeIds)
    }
    return registerAgentNodeRun({
      projectId,
      quote,
      review: (proposal, signature) => {
        const plan = quote(proposal)
        if (!plan || plan.signature !== signature || plan.error || plan.blocked) return false
        return reviewRef.current([...proposal.nodeIds], plan)
      },
    })
  }, [active, projectId, canvas, editor, revision, files, settings, params, draft])
}
