import { expect, it } from 'vitest'
import {
  confirmationHints,
  resolvePendingConfirmations,
} from '../../../../features/agent/lib/pendingConfirmations'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

function tool(patch: Partial<AgentToolMessage> & Pick<AgentToolMessage, 'id'>): AgentToolMessage {
  return {
    kind: 'tool',
    turnId: 'turn',
    toolCallId: patch.id,
    title: patch.id,
    status: 'succeeded',
    ...patch,
  }
}

const messages: AgentPanelMessage[] = [
  tool({ id: 'draft', status: 'awaiting_confirmation', toolName: 'editImage' }),
  tool({
    id: 'production',
    status: 'awaiting_confirmation',
    productionDraftRevision: 1,
  }),
  tool({ id: 'batch', batchId: 'batch-1', toolName: 'planImageBatch' }),
  tool({ id: 'closed-batch', batchId: 'batch-2', toolName: 'planImageBatch' }),
  tool({
    id: 'nodes',
    canvasRun: { projectId: 'project', nodeIds: ['n1'] },
    toolName: 'runNodes',
  }),
  tool({
    id: 'auto-nodes',
    canvasRun: { projectId: 'project', nodeIds: ['n2'], autoRun: true },
    toolName: 'runNodes',
  }),
  { kind: 'text', id: 'user', turnId: 'turn', role: 'user', text: '确认', streaming: false },
]

it('keeps drafts, draft batches and unstarted node runs', () => {
  const pending = resolvePendingConfirmations(
    confirmationHints(messages),
    new Set(['batch-1']),
    (id) => id === 'nodes-started',
  )
  expect(pending).toEqual([
    { kind: 'draft', messageId: 'draft' },
    { kind: 'batch', messageId: 'batch', batchId: 'batch-1' },
    { kind: 'nodeRun', messageId: 'nodes' },
  ])
})

it('drops a node run once it has started, and counts one card per draft batch', () => {
  const hints = confirmationHints([
    tool({ id: 'nodes', canvasRun: { projectId: 'project', nodeIds: ['n1'] } }),
    tool({ id: 'batch-a', batchId: 'batch-1' }),
    tool({ id: 'batch-b', batchId: 'batch-1' }),
  ])
  expect(resolvePendingConfirmations(hints, new Set(['batch-1']), () => true)).toEqual([
    { kind: 'batch', messageId: 'batch-a', batchId: 'batch-1' },
  ])
})
