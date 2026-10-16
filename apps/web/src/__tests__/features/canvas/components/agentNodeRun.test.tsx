// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import AgentNodeRunCard from '../../../../features/agent/components/AgentNodeRunCard'
import { agentNodeRunBridge } from '../../../../features/agent/lib/nodeRunBridge'
import NodeBatchDialog from '../../../../features/canvas/components/NodeBatchDialog'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type { NodeBatchPlan } from '../../../../features/canvas/lib/nodeBatch'
import { useAgentNodeRun } from '../../../../features/canvas/lib/useAgentNodeRun'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  run: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}))
vi.mock('../../../../features/canvas/lib/nodeBatch', async (original) => ({
  ...(await original<typeof import('../../../../features/canvas/lib/nodeBatch')>()),
  currentNodeBatch: mocks.current,
  runNodeBatch: mocks.run,
}))
it('keeps proposals inert across rendering, checks project and price drift, and submits only after both confirmations', async () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => {} },
    editor = new CanvasEditor(new CanvasDoc())
  insertCanvasNode(
    doc,
    { id: 'a', type: 'image', x: 0, y: 0, width: 100, height: 100, data: {} },
    origin,
  )
  const proposal = { projectId: 'project', nodeIds: ['a'] }
  let plan: NodeBatchPlan = {
    signature: 'first',
    credits: 20,
    jobs: [
      {
        id: 'a',
        kind: 'image',
        label: '萌芽',
        model: 'fixture',
        quantity: 2,
        prompt: '芽',
        refs: [],
        roles: {},
        temporary: {},
        dependencies: [],
      },
    ],
    settings: useStore.getState().settings,
    params: useStore.getState().params,
  }
  mocks.current.mockImplementation(() => plan)
  const reviewed = vi.fn()
  function Canvas() {
    const [review, setReview] = useState<NodeBatchPlan>()
    useAgentNodeRun({
      canvas,
      editor,
      projectId: 'project',
      active: true,
      revision: plan.signature,
      files: {},
      review: (ids, quote) => {
        reviewed(ids)
        setReview(quote)
        return true
      },
    })
    return (
      <>
        <AgentNodeRunCard proposal={proposal} />
        {review && (
          <NodeBatchDialog
            canvas={canvas}
            editor={editor}
            ids={proposal.nodeIds}
            snapshot={readCanvasDocument(doc)}
            initialPlan={review}
            onClose={() => setReview(undefined)}
          />
        )}
      </>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
  try {
    await act(async () => root.render(<Canvas />))
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(agentNodeRunBridge()?.quote({ ...proposal, projectId: 'foreign' })).toBeNull()
    expect(agentNodeRunBridge()?.quote({ ...proposal, nodeIds: ['deleted'] })).toBeNull()
    plan = { ...plan, signature: 'price-change', credits: 30 }
    await act(async () => button('检查节点并确认').click())
    expect(reviewed).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
    await act(async () => button('检查节点并确认').click())
    expect(reviewed).toHaveBeenCalledWith(['a'])
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    expect(mocks.run).not.toHaveBeenCalled()
    await act(async () => button('取消').click())
    expect(mocks.run).not.toHaveBeenCalled()
    await act(async () => button('检查节点并确认').click())
    plan = { ...plan, signature: 'prompt-change' }
    await act(async () => root.render(<Canvas />))
    expect(button('确认并执行')).toBeUndefined()
    await act(async () => button('重新预估').click())
    await act(async () => button('确认并执行').click())
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.run.mock.calls[0]?.[3]).toMatchObject({ signature: 'prompt-change' })
  } finally {
    await act(async () => root.unmount())
    host.remove()
    undo.destroy()
    doc.destroy()
  }
  expect(agentNodeRunBridge()).toBeNull()
})
