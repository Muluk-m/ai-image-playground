// @vitest-environment jsdom
import { canvasOrigin, createCanvasUndoManager, insertCanvasNode } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import AgentNodeRunCard from '../../../../features/agent/components/AgentNodeRunCard'
import { agentNodeRunBridge } from '../../../../features/agent/lib/nodeRunBridge'
import { startAgentNodeRun } from '../../../../features/agent/lib/nodeRuns'
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

const proposal = { projectId: 'project', nodeIds: ['a'] }
let plan: NodeBatchPlan
let cleanup: () => Promise<void>

function fixturePlan(signature: string): NodeBatchPlan {
  return {
    signature,
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
}

async function mount(runKey: string) {
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
  function Canvas() {
    useAgentNodeRun({
      canvas,
      editor,
      projectId: 'project',
      active: true,
      revision: plan.signature,
      files: {},
    })
    return <AgentNodeRunCard runKey={runKey} proposal={proposal} />
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Canvas />))
  cleanup = async () => {
    await act(async () => root.unmount())
    host.remove()
    undo.destroy()
    doc.destroy()
  }
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text)

beforeEach(() => {
  plan = fixturePlan('first')
  mocks.current.mockImplementation(() => plan)
  mocks.run.mockReset()
  mocks.run.mockImplementation(async () => {})
})
afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
  expect(agentNodeRunBridge()).toBeNull()
})

it('keeps proposals inert until the card is confirmed once, then runs the current quote', async () => {
  await mount('confirm')
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(agentNodeRunBridge()?.quote({ ...proposal, projectId: 'foreign' })).toBeNull()
  expect(agentNodeRunBridge()?.quote({ ...proposal, nodeIds: ['deleted'] })).toBeNull()
  await act(async () => button('确认运行')!.click())
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(mocks.run.mock.calls[0]?.[2]).toEqual(['a'])
  expect(mocks.run.mock.calls[0]?.[3]).toMatchObject({ signature: 'first' })
  expect(document.body.textContent).toContain('本组生成已完成。')
  expect(button('确认运行')).toBeUndefined()
  expect(startAgentNodeRun('confirm', proposal)).toBe(false)
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('refuses to confirm a blocked quote', async () => {
  plan = { ...fixturePlan('busy'), error: 'busy' }
  await mount('blocked')
  expect(button('确认运行')?.disabled).toBe(true)
  expect(startAgentNodeRun('blocked', proposal)).toBe(false)
  expect(mocks.run).not.toHaveBeenCalled()
})

it('lets an auto run be undone during the countdown without submitting', async () => {
  vi.useFakeTimers()
  await mount('undo')
  await act(async () => {
    startAgentNodeRun('undo', proposal, 5)
  })
  expect(document.body.textContent).toContain('5 秒后开始运行')
  await act(async () => vi.advanceTimersByTime(2000))
  await act(async () => button('撤销（3 秒）')!.click())
  await act(async () => vi.advanceTimersByTime(5000))
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('已撤销，没有提交任务。')
})

it('starts an auto run after the countdown and fails closed when the canvas changed meanwhile', async () => {
  vi.useFakeTimers()
  await mount('auto')
  await act(async () => {
    startAgentNodeRun('auto', proposal, 5)
  })
  plan = fixturePlan('edited')
  await act(async () => vi.advanceTimersByTime(5000))
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('节点输入、设置或计价已改变')
})

it('stops later nodes when the running card is stopped', async () => {
  let signal: AbortSignal | undefined
  mocks.run.mockImplementation(
    (...args: unknown[]) =>
      new Promise<void>((_resolve, reject) => {
        signal = args[4] as AbortSignal
        signal.addEventListener('abort', () => reject({ code: 'cancelled' }))
      }),
  )
  await mount('stop')
  await act(async () => button('确认运行')!.click())
  expect(document.body.textContent).toContain('正在运行')
  await act(async () => button('停止后续任务')!.click())
  expect(signal?.aborted).toBe(true)
  expect(document.body.textContent).toContain('已停止后续任务')
})
