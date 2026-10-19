// @vitest-environment jsdom
import { canvasOrigin, createCanvasUndoManager, insertCanvasNode } from '@image-playground/shared'
import type { AgentCanvasRunProposal, StageAuthorization } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import AgentNodeRunCard from '../../../../features/agent/components/AgentNodeRunCard'
import { agentNodeRunBridge } from '../../../../features/agent/lib/nodeRunBridge'
import { registerAgentNodeRunOrigin, startAgentNodeRun } from '../../../../features/agent/lib/nodeRuns'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type { NodeBatchPlan } from '../../../../features/canvas/lib/nodeBatch'
import { useAgentNodeRun } from '../../../../features/canvas/lib/useAgentNodeRun'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({ current: vi.fn(), run: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}) }))
// The batch runner is the canvas execution boundary of the authorization store seam.
vi.mock('../../../../features/canvas/lib/nodeBatch', async (original) => ({
  ...(await original<typeof import('../../../../features/canvas/lib/nodeBatch')>()),
  currentNodeBatch: mocks.current, runNodeBatch: mocks.run,
}))
const proposal: AgentCanvasRunProposal = { projectId: 'project', nodeIds: ['a'], nodeNames: ['萌芽'], authorizationId: 'authorization', stage: '素材', estimatedCredits: 20, budgetCap: 20, status: 'pending' }
let plan: NodeBatchPlan
let authorization: StageAuthorization
let rejectPreflight: boolean
let confirms: number
let preflights: number
let cleanup: () => Promise<void>
function fixturePlan(signature: string): NodeBatchPlan {
  return { signature, credits: 20, jobs: [{ id: 'a', kind: 'image', label: '萌芽', model: 'fixture', quantity: 2, prompt: '芽', refs: [], roles: {}, temporary: {}, dependencies: [] }], settings: useStore.getState().settings, params: useStore.getState().params }
}
async function mount(runKey: string, origin = true) {
  if (origin) registerAgentNodeRunOrigin(runKey)
  const doc = new Y.Doc(), source = canvasOrigin('user', 'test'), undo = createCanvasUndoManager(doc, source)
  const canvas = { doc, origin: source, undo, destroy: async () => {} }, editor = new CanvasEditor(new CanvasDoc())
  insertCanvasNode(doc, { id: 'a', type: 'image', x: 0, y: 0, width: 100, height: 100, data: {} }, source)
  function Canvas() {
    useAgentNodeRun({ canvas, editor, projectId: 'project', active: true, revision: plan.signature, files: {} })
    return <AgentNodeRunCard runKey={runKey} proposal={proposal} />
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Canvas />))
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); undo.destroy(); doc.destroy() }
}
const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)
beforeEach(() => {
  vi.useFakeTimers()
  rejectPreflight = false; confirms = 0; preflights = 0
  authorization = { id: 'authorization', conversationId: 'conversation', projectId: 'project', stage: '素材', nodeIds: ['a'], nodeNames: ['萌芽'], estimatedCredits: 20, budgetCap: 20, spentCredits: 0, status: 'pending', attempts: [], audit: [] }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/confirm')) {
      confirms += 1
      authorization = { ...authorization, status: 'active' }
      return Response.json({ authorization, executionToken: 'ephemeral-token' })
    }
    if (url.endsWith('/preflight')) {
      preflights += 1
      if (rejectPreflight) return Response.json({ error: 'stage_authorization_budget' }, { status: 409 })
    }
    if (url.endsWith('/end')) authorization = { ...authorization, status: 'ended' }
    return Response.json(authorization)
  }))
  plan = fixturePlan('first')
  mocks.current.mockImplementation(() => plan)
  mocks.run.mockReset()
  mocks.run.mockImplementation(async () => { authorization = { ...authorization, spentCredits: 20 } })
})
afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); expect(agentNodeRunBridge()).toBeNull() })
it('shows scope and budget, confirms once, then preflights and runs only after the undo window', async () => {
  await mount('confirm')
  expect(document.body.textContent).toContain('素材')
  expect(document.body.textContent).toContain('预算上限20')
  expect(document.body.textContent).toContain('萌芽')
  expect(mocks.run).not.toHaveBeenCalled()
  await act(async () => button('确认运行')!.click())
  expect(confirms).toBe(1)
  expect(preflights).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(startAgentNodeRun('confirm', proposal)).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(preflights).toBe(1)
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(mocks.run.mock.calls[0]?.[6]).toMatchObject({ a: { authorizationId: 'authorization', executionToken: 'ephemeral-token', nodeId: 'a' } })
  expect(document.body.textContent).toContain('本组生成已完成。')
  expect(document.body.textContent).toContain('已用额度20')
})
it('refuses to confirm a blocked quote', async () => {
  plan = { ...fixturePlan('busy'), error: 'busy' }
  await mount('blocked')
  expect(button('确认运行')?.disabled).toBe(true)
  expect(startAgentNodeRun('blocked', proposal)).toBe(false)
  expect(confirms).toBe(0)
})
it('ends authorization before start when the countdown is undone', async () => {
  await mount('undo')
  await act(async () => button('确认运行')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await act(async () => button('撤销（3 秒）')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(preflights).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(authorization).toMatchObject({ status: 'ended', spentCredits: 0 })
  expect(document.body.textContent).toContain('已撤销，没有提交任务。')
})
it('fails closed when the canvas changes during the undo window', async () => {
  await mount('changed')
  await act(async () => button('确认运行')!.click())
  plan = fixturePlan('edited')
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('节点输入、设置或计价已改变')
})
it('does not submit when the BFF refuses scope or budget', async () => {
  rejectPreflight = true
  await mount('budget')
  await act(async () => button('确认运行')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('请让智能体重新提出阶段授权')
})
it.each(['pending', 'active'] as const)('only renders a %s restored card on refresh or another device', async (status) => {
  authorization = { ...authorization, status }
  await mount(`restored-${status}`, false)
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(button('确认运行')).toBeUndefined()
  expect(startAgentNodeRun(`restored-${status}`, proposal)).toBe(false)
  expect(confirms).toBe(0)
  expect(preflights).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('刷新不会自动运行')
})
it('stops later nodes when the running card is stopped', async () => {
  let signal: AbortSignal | undefined
  mocks.run.mockImplementation((...args: unknown[]) => new Promise<void>((_resolve, reject) => {
    signal = args[4] as AbortSignal
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })))
  }))
  await mount('stop')
  await act(async () => button('确认运行')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  await act(async () => button('停止后续任务')!.click())
  expect(signal?.aborted).toBe(true)
  expect(document.body.textContent).toContain('已停止后续任务')
})
