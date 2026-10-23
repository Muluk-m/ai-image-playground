import type { StageAuthorizationSubmission, StageRunReason } from '@image-playground/shared'
import {
  type AgentCanvasRunProposal,
  readCanvasDocument,
  stageExecutionSpecsMatch,
} from '@image-playground/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { getStoredChannels, subscribeChannels } from '../../../lib/channels/channelStore'
import { useStore } from '../../../store'
import { registerAgentNodeRun } from '../../agent/lib/nodeRunBridge'
import { stageAuthorizationClient } from '../../agent/lib/stageAuthorizationClient'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from './editor'
import { billedNodeQuantity, currentNodeBatch, NodeBatchFailure, runNodeBatch } from './nodeBatch'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

/**
 * 提交被阶段授权拦下时，把 BFF 的错误码翻成报给智能体的原因；不是授权拒绝就返回 undefined，
 * 照常按上游失败处理（可以重试一次）。
 */
export function stageRejectionReason(code: string | undefined): StageRunReason | undefined {
  // 只认已知的拒绝码；没列出的（含以后新增的）按普通失败走原来的重试流程，不猜原因。
  switch (code) {
    case 'stage_authorization_scope':
    case 'stage_authorization_attempt_conflict': // 模型、倍率或数量和授权时不一致
      return 'spec_changed'
    case 'stage_authorization_budget':
      return 'budget_exceeded'
    case 'stage_authorization_retry_limit':
      return 'retry_limit'
    case 'stage_authorization_inactive':
    case 'stage_authorization_not_found':
    case 'stage_authorization_stale':
      return 'authorization'
    default:
      return undefined
  }
}

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
  // 模型清单刷新后重新登记：卡片与直接出图按新清单报价（视频模型被停用或恢复）。
  const channels = useSyncExternalStore(subscribeChannels, getStoredChannels)
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
      run: async (proposal, signature, signal, progress, executionToken, record) => {
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
        const retried = new Set<string>()
        await runNodeBatch(
          canvas.doc,
          editor,
          proposal.nodeIds,
          plan,
          signal,
          progress,
          authorizations,
          {
            // 授权内同一节点至多自动重试一次；重试另开一次预检，花费计入授权已用额度。
            recover: async (job, error) => {
              if (!(error instanceof NodeBatchFailure) || error.code !== 'failed') throw error
              const failed = (reason: StageRunReason) => {
                record?.({
                  nodeId: job.id,
                  outcome: 'failed',
                  reason,
                  ...(retried.has(job.id) ? { retried: true } : {}),
                })
                return 'skip' as const
              }
              // BFF 按授权拒绝了这次提交：原样再提一遍还是同样被拒，不白占一次重试，直接报原因。
              const rejected = stageRejectionReason(error.submitError)
              if (rejected) return failed(rejected)
              if (retried.has(job.id)) return failed('generation_failed')
              if (signal.aborted) throw new NodeBatchFailure('cancelled')
              const attemptId = crypto.randomUUID()
              try {
                await stageAuthorizationClient.preflight(authorizationId, {
                  executionToken,
                  attemptId,
                  nodeId: job.id,
                  model: job.model,
                  quantity: billedNodeQuantity(job),
                  unitMultiplier: job.unitMultiplier ?? 1,
                })
              } catch (rejected) {
                // 重试前的预检被拒和提交被拒用同一张映射，原因说法保持一致。
                const code = rejected instanceof Error ? rejected.message : undefined
                return failed(stageRejectionReason(code) ?? 'generation_failed')
              }
              authorizations[job.id] = {
                authorizationId,
                nodeId: job.id,
                attemptId,
                executionToken,
              }
              retried.add(job.id)
              return 'retry'
            },
            completed: (job) =>
              record?.({
                nodeId: job.id,
                outcome: 'completed',
                ...(retried.has(job.id) ? { retried: true } : {}),
              }),
            skipped: (job) =>
              record?.({ nodeId: job.id, outcome: 'skipped', reason: 'upstream_failed' }),
          },
        )
      },
    })
  }, [active, projectId, canvas, editor, revision, files, settings, params, draft, channels])
}
