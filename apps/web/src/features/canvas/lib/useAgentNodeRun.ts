import { type AgentCanvasRunProposal, readCanvasDocument } from '@image-playground/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { getStoredChannels, subscribeChannels } from '../../../lib/channels/channelStore'
import { useStore } from '../../../store'
import { registerAgentNodeRun } from '../../agent/lib/nodeRunBridge'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from './editor'
import { currentNodeBatch, runNodeBatch } from './nodeBatch'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export function useAgentNodeRun({
  canvas,
  editor,
  projectId,
  active,
  revision,
  files,
  syncResults,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  projectId?: string
  active: boolean
  revision: unknown
  files: unknown
  syncResults?: () => Promise<void>
}) {
  const settings = useStore((state) => state.settings)
  const params = useStore((state) => state.params)
  const draft = useVideoStore((state) => state.draft)
  // 模型清单刷新后重新登记：卡片与直接出图按新清单报价（视频模型被停用或恢复）。
  const channels = useSyncExternalStore(subscribeChannels, getStoredChannels)
  useEffect(() => {
    if (!active || !projectId || !syncResults) return
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
      syncResults,
      quote,
      run: (proposal, plan, execution) =>
        runNodeBatch(
          canvas.doc,
          editor,
          proposal.nodeIds,
          plan,
          execution.signal,
          execution.progress,
          execution.authorizations,
          execution.hooks,
        ),
    })
  }, [
    active,
    projectId,
    canvas,
    editor,
    revision,
    files,
    settings,
    params,
    draft,
    channels,
    syncResults,
  ])
}
