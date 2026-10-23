// @vitest-environment jsdom

import type { AgentCanvasRunProposal, StageAuthorization } from '@image-playground/shared'
import { canvasOrigin, createCanvasUndoManager, insertCanvasNode } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import AgentNodeRunCard from '../../../../features/agent/components/AgentNodeRunCard'
import { agentNodeRunBridge } from '../../../../features/agent/lib/nodeRunBridge'
import {
  agentNodeRun,
  isAgentNodeRunOrigin,
  noteAgentNodeRunBlocked,
  registerAgentNodeRunOrigin,
  startAgentNodeRun,
} from '../../../../features/agent/lib/nodeRuns'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  NodeBatchFailure,
  type NodeBatchHooks,
  type NodeBatchPlan,
} from '../../../../features/canvas/lib/nodeBatch'
import { useAgentNodeRun } from '../../../../features/canvas/lib/useAgentNodeRun'
import { setClientStorageScope } from '../../../../lib/authScope'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  run: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}))
// The batch runner is the canvas execution boundary of the authorization store seam.
vi.mock('../../../../features/canvas/lib/nodeBatch', async (original) => ({
  ...(await original<typeof import('../../../../features/canvas/lib/nodeBatch')>()),
  currentNodeBatch: mocks.current,
  runNodeBatch: mocks.run,
}))
const proposal: AgentCanvasRunProposal = {
  projectId: 'project',
  nodeIds: ['a'],
  nodeNames: ['萌芽'],
  authorizationId: 'authorization',
  stage: '素材',
  estimatedCredits: 20,
  budgetCap: 20,
  status: 'pending',
}
let plan: NodeBatchPlan
let authorization: StageAuthorization
let rejectPreflight: boolean
let preflightCode: string
let loseReport: boolean
let reportWake: 'queued' | 'duplicate'
let ends: number
let confirms: number
let preflights: number
let reports: { nodes: { nodeId: string; outcome: string; reason?: string; retried?: boolean }[] }[]
let blocked: { url: string; nodes: unknown }[]
let loseBlocked: boolean
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
async function mount(
  runKey: string,
  origin = true,
  next: AgentCanvasRunProposal = proposal,
  onReported?: (authorizationId: string) => void,
  card = true,
) {
  if (origin) registerAgentNodeRunOrigin(runKey, onReported ? { onReported } : {}, next)
  const doc = new Y.Doc(),
    source = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, source)
  const canvas = { doc, origin: source, undo, destroy: async () => {} },
    editor = new CanvasEditor(new CanvasDoc())
  insertCanvasNode(
    doc,
    { id: 'a', type: 'image', x: 0, y: 0, width: 100, height: 100, data: {} },
    source,
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
    // 聊天面板收起时只有画布挂着，运行卡不渲染。
    return card ? <AgentNodeRunCard runKey={runKey} proposal={next} /> : null
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
  [...document.querySelectorAll('button')].find((item) => item.textContent === text)
beforeEach(() => {
  vi.useFakeTimers()
  rejectPreflight = false
  preflightCode = 'stage_authorization_budget'
  loseReport = false
  reportWake = 'queued'
  ends = 0
  confirms = 0
  preflights = 0
  reports = []
  blocked = []
  loseBlocked = false
  authorization = {
    id: 'authorization',
    conversationId: 'conversation',
    projectId: 'project',
    stage: '素材',
    nodeIds: ['a'],
    nodeNames: ['萌芽'],
    estimatedCredits: 20,
    budgetCap: 20,
    spentCredits: 0,
    status: 'pending',
    attempts: [],
    audit: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/report')) {
        reports.push(JSON.parse(String(init?.body)))
        authorization = { ...authorization, status: 'ended' }
        // 服务端已经收下，响应却在路上丢了。
        if (loseReport) throw new TypeError('Failed to fetch')
        return Response.json({ authorization, wake: reportWake })
      }
      if (url.endsWith('/blocked')) {
        if (loseBlocked) throw new TypeError('Failed to fetch')
        blocked.push({ url, nodes: JSON.parse(String(init?.body)).nodes })
        return Response.json({ logged: true })
      }
      if (url.endsWith('/wake'))
        return reports.length
          ? Response.json({ status: 'pending' })
          : Response.json({ error: 'stage_run_not_reported' }, { status: 404 })
      if (url.endsWith('/confirm')) {
        confirms += 1
        authorization = {
          ...authorization,
          status: 'active',
          audit: [...authorization.audit, { kind: 'confirmed', at: Date.now() }],
        }
        return Response.json({ authorization, executionToken: 'ephemeral-token' })
      }
      if (url.endsWith('/preflight')) {
        preflights += 1
        if (rejectPreflight) return Response.json({ error: preflightCode }, { status: 409 })
      }
      if (url.endsWith('/end')) {
        ends += 1
        authorization = { ...authorization, status: 'ended' }
      }
      return Response.json(authorization)
    }),
  )
  plan = fixturePlan('first')
  mocks.current.mockImplementation(() => plan)
  mocks.run.mockReset()
  mocks.run.mockImplementation(async (...args: unknown[]) => {
    authorization = { ...authorization, spentCredits: 20 }
    for (const job of plan.jobs) (args[7] as NodeBatchHooks | undefined)?.completed?.(job)
  })
})
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  expect(agentNodeRunBridge()).toBeNull()
})
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
  expect(mocks.run.mock.calls[0]?.[6]).toMatchObject({
    a: { authorizationId: 'authorization', executionToken: 'ephemeral-token', nodeId: 'a' },
  })
  expect(document.body.textContent).toContain('本组生成已完成。')
  expect(document.body.textContent).toContain('已用额度20')
  expect(reports).toEqual([
    expect.objectContaining({
      executionToken: 'ephemeral-token',
      nodes: [{ nodeId: 'a', outcome: 'completed' }],
    }),
  ])
  expect(document.body.textContent).toContain('已把这批结果交给智能体')
})
it('reports the batch once and hands the wake to the origin', async () => {
  const onReported = vi.fn()
  await mount('reported', true, { ...proposal, direct: true }, onReported)
  await act(async () => {})
  expect(reports).toHaveLength(1)
  expect(onReported).toHaveBeenCalledWith('authorization')
  expect(authorization.status).toBe('ended')
})
it('still follows the wake when the report response is lost after the server took it', async () => {
  loseReport = true
  const onReported = vi.fn()
  await mount('lost-report', true, { ...proposal, direct: true }, onReported)
  await act(async () => {})
  expect(reports).toHaveLength(1)
  expect(onReported).toHaveBeenCalledWith('authorization')
  expect(ends).toBe(0)
  expect(document.body.textContent).toContain('已把这批结果交给智能体')
})
it('follows the wake of a batch the server had already taken', async () => {
  reportWake = 'duplicate'
  const onReported = vi.fn()
  await mount('duplicate-report', true, { ...proposal, direct: true }, onReported)
  await act(async () => {})
  expect(onReported).toHaveBeenCalledWith('authorization')
})
it('retries a failed node once inside the authorization, then reports it failed', async () => {
  mocks.run.mockImplementation(async (...args: unknown[]) => {
    const hooks = args[7] as NodeBatchHooks
    const job = plan.jobs[0]!
    expect(await hooks.recover?.(job, new NodeBatchFailure('failed'))).toBe('retry')
    expect(await hooks.recover?.(job, new NodeBatchFailure('failed'))).toBe('skip')
  })
  await mount('retry', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(preflights).toBe(2)
  expect(reports[0]?.nodes).toEqual([
    { nodeId: 'a', outcome: 'failed', reason: 'generation_failed', retried: true },
  ])
})
it('stops retrying when the retry would exceed the budget', async () => {
  mocks.run.mockImplementation(async (...args: unknown[]) => {
    rejectPreflight = true
    const hooks = args[7] as NodeBatchHooks
    expect(await hooks.recover?.(plan.jobs[0]!, new NodeBatchFailure('failed'))).toBe('skip')
  })
  await mount('retry-budget', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(preflights).toBe(2)
  expect(reports[0]?.nodes).toEqual([{ nodeId: 'a', outcome: 'failed', reason: 'budget_exceeded' }])
})
it('reports a retry preflight rejected as inactive with the authorization reason', async () => {
  mocks.run.mockImplementation(async (...args: unknown[]) => {
    rejectPreflight = true
    preflightCode = 'stage_authorization_inactive'
    const hooks = args[7] as NodeBatchHooks
    expect(await hooks.recover?.(plan.jobs[0]!, new NodeBatchFailure('failed'))).toBe('skip')
  })
  await mount('retry-inactive', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(reports[0]?.nodes).toEqual([{ nodeId: 'a', outcome: 'failed', reason: 'authorization' }])
})
it('reports a direct run blocked before start with the missing input', async () => {
  const job = fixturePlan('media').jobs[0]!
  plan = { ...fixturePlan('media'), error: 'media', jobs: [{ ...job, blocked: 'missing_media' }] }
  await mount('blocked-direct', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(confirms).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(reports).toEqual([
    {
      nodes: [{ nodeId: 'a', outcome: 'blocked', reason: 'missing_media' }],
      deviceId: expect.any(String),
    },
  ])
})
it('shows the shot table summary on a first-frame stage card and says confirming finalizes it', async () => {
  await mount('frames', true, {
    ...proposal,
    stage: '首帧',
    storyboard: {
      storyboardId: 'board',
      shotCount: 2,
      totalSeconds: 9,
      shots: [
        { id: 'shot-1', durationSeconds: 4, line: '林夏蹲在窗台前。' },
        { id: 'shot-2', durationSeconds: 5, line: '窗台特写' },
      ],
    },
  })
  const text = document.body.textContent
  expect(text).toContain('镜头表：2 镜，共 9 秒')
  expect(text).toContain('第 1 镜 · 4 秒 · 林夏蹲在窗台前。')
  expect(text).toContain('第 2 镜 · 5 秒 · 窗台特写')
  expect(text).toContain('确认即把这张分镜表定稿')
  await act(async () => button('确认运行')!.click())
  expect(confirms).toBe(1)
})
it('says the storyboard is finalized once a direct first-frame run has confirmed it', async () => {
  await mount('direct-frames', true, {
    ...proposal,
    stage: '首帧',
    direct: true,
    storyboard: {
      storyboardId: 'board',
      shotCount: 1,
      totalSeconds: 4,
      shots: [{ id: 'shot-1', durationSeconds: 4, line: '林夏蹲在窗台前。' }],
    },
  })
  await act(async () => {})
  expect(confirms).toBe(1)
  expect(mocks.run).toHaveBeenCalledOnce()
  const text = document.body.textContent
  expect(text).toContain('镜头表：1 镜，共 4 秒')
  expect(text).toContain('这张分镜表已定稿')
  expect(text).not.toContain('确认即把这张分镜表定稿')
})
it('starts a direct run with no confirmation card and no undo wait', async () => {
  await mount('direct', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(button('确认运行')).toBeUndefined()
  expect(document.body.textContent).not.toContain('确认运行')
  expect(document.body.textContent).not.toContain('撤销')
  expect(confirms).toBe(1)
  expect(preflights).toBe(1)
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('starts a direct run while the chat panel is collapsed and no run card is mounted', async () => {
  await mount('direct-collapsed', true, { ...proposal, direct: true }, undefined, false)
  await act(async () => {})
  expect(confirms).toBe(1)
  expect(preflights).toBe(1)
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(reports).toEqual([
    expect.objectContaining({ nodes: [{ nodeId: 'a', outcome: 'completed' }] }),
  ])
  // 没有卡来收尾：跑完交过结局，运行和来源都得由运行表自己收走，不在标签页里一直留着。
  expect(agentNodeRun('direct-collapsed')).toBeUndefined()
  expect(isAgentNodeRunOrigin('direct-collapsed')).toBe(false)
})

it('releases a collapsed-panel run even when the account switched mid-run', async () => {
  mocks.run.mockImplementationOnce(async () => {
    setClientStorageScope('someone-else')
  })
  try {
    await mount('direct-switched', true, { ...proposal, direct: true }, undefined, false)
    await act(async () => {})
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(ends).toBe(1)
    // 换账号后不写回执，但跑完的运行和来源照样收走。
    expect(agentNodeRun('direct-switched')).toBeUndefined()
    expect(isAgentNodeRunOrigin('direct-switched')).toBe(false)
  } finally {
    setClientStorageScope(null)
  }
})

it('releases a collapsed-panel run when the account switches while confirming', async () => {
  const served = fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await served(input, init)
      if (String(input).endsWith('/confirm')) setClientStorageScope('someone-else')
      return response
    }),
  )
  try {
    await mount('direct-switched-confirm', true, { ...proposal, direct: true }, undefined, false)
    await act(async () => {})
    expect(confirms).toBe(1)
    expect(mocks.run).not.toHaveBeenCalled()
    // 停在「确认中」退出的运行不是终局，也得收走，不在标签页里一直留着。
    expect(agentNodeRun('direct-switched-confirm')).toBeUndefined()
    expect(isAgentNodeRunOrigin('direct-switched-confirm')).toBe(false)
  } finally {
    setClientStorageScope(null)
  }
})

it('waits for the canvas of the proposal before starting a direct run', async () => {
  await mount('direct-other-project', true, {
    ...proposal,
    projectId: 'another',
    direct: true,
  })
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(confirms).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
})

it('stops rereading an authorization after repeated failures', async () => {
  let reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads += 1
      return new Response('unavailable', { status: 503 })
    }),
  )
  await mount('read-backoff')
  expect(reads).toBe(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(reads).toBe(5)
  expect(document.body.textContent).toContain('读不到授权状态')
  expect(button('确认运行')).toBeUndefined()
  await act(async () => button('重试')!.click())
  expect(reads).toBe(6)
})

it('does not start a direct run from another device', async () => {
  await mount('direct-elsewhere', false, { ...proposal, direct: true })
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(button('确认运行')).toBeUndefined()
  expect(confirms).toBe(0)
  expect(preflights).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
})

it('refuses to confirm a blocked quote', async () => {
  plan = { ...fixturePlan('busy'), error: 'busy' }
  await mount('blocked')
  expect(button('确认运行')?.disabled).toBe(true)
  expect(startAgentNodeRun('blocked', proposal)).toBe(false)
  expect(confirms).toBe(0)
})
it('logs a confirmation card blocked before it ran once, without reporting or ending it', async () => {
  const job = fixturePlan('model').jobs[0]!
  plan = {
    ...fixturePlan('model'),
    error: 'model',
    jobs: [{ ...job, blocked: 'model_unavailable' }],
  }
  await mount('blocked-card', true, { ...proposal, authorizationId: 'blocked-card' })
  await act(async () => {})
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(button('确认运行')?.disabled).toBe(true)
  expect(blocked).toEqual([
    {
      url: expect.stringContaining('/api/agent/stage-authorizations/blocked-card/blocked'),
      nodes: [{ nodeId: 'a', outcome: 'blocked', reason: 'model_unavailable' }],
    },
  ])
  expect(reports).toEqual([])
  expect(ends).toBe(0)
  expect(confirms).toBe(0)
})
it('logs a blocked card again after the first attempt failed to reach the server', async () => {
  const job = fixturePlan('model').jobs[0]!
  const blockedPlan = {
    ...fixturePlan('model'),
    error: 'model' as const,
    jobs: [{ ...job, blocked: 'model_unavailable' as const }],
  }
  const card = { ...proposal, authorizationId: 'retry-card' }
  loseBlocked = true
  noteAgentNodeRunBlocked(card, blockedPlan)
  await vi.advanceTimersByTimeAsync(0)
  loseBlocked = false
  noteAgentNodeRunBlocked(card, blockedPlan)
  await vi.advanceTimersByTimeAsync(0)
  noteAgentNodeRunBlocked(card, blockedPlan)
  await vi.advanceTimersByTimeAsync(0)
  expect(blocked).toHaveLength(1)
  cleanup = async () => {}
})
it('does not log a card that can still run', async () => {
  await mount('runnable-card', true, { ...proposal, authorizationId: 'runnable-card' })
  await act(async () => {})
  expect(button('确认运行')?.disabled).toBe(false)
  expect(blocked).toEqual([])
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
it('stops a browser-only upload before confirm and does not submit', async () => {
  const job = fixturePlan('local').jobs[0]!
  plan = { ...fixturePlan('local'), jobs: [{ ...job, temporary: { draft: 'data:draft' } }] }
  await mount('local-upload', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(confirms).toBe(0)
  expect(preflights).toBe(0)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('没有写入画布')
  expect(authorization.status).toBe('ended')
  expect(reports[0]?.nodes).toEqual([{ nodeId: 'a', outcome: 'blocked', reason: 'local_upload' }])
})
it('asks for a new proposal when the workbench spec no longer matches the snapshot', async () => {
  const snapped = {
    ...proposal,
    specs: [{ nodeId: 'a', model: 'other-model', quantity: 2, unitMultiplier: 1 }],
  }
  await mount('stale-spec', true, snapped)
  await act(async () => {})
  expect(document.body.textContent).toContain('工作台模型或规格已变化，请让智能体重新提出阶段授权')
  expect(startAgentNodeRun('stale-spec', snapped)).toBe(false)
  expect(confirms).toBe(0)
  expect(preflights).toBe(0)
})
it('does not submit when the BFF refuses scope or budget', async () => {
  rejectPreflight = true
  await mount('budget')
  await act(async () => button('确认运行')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(mocks.run).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('请让智能体重新提出阶段授权')
})
it.each([
  'pending',
  'active',
] as const)('only renders a %s restored card on refresh or another device', async (status) => {
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
  mocks.run.mockImplementation(
    (...args: unknown[]) =>
      new Promise<void>((_resolve, reject) => {
        signal = args[4] as AbortSignal
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })),
        )
      }),
  )
  await mount('stop')
  await act(async () => button('确认运行')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  await act(async () => button('停止后续任务')!.click())
  expect(signal?.aborted).toBe(true)
  expect(document.body.textContent).toContain('已停止后续任务')
  // 用户自己停下不唤醒智能体。
  await act(async () => {})
  expect(reports).toHaveLength(0)
})
it('does not retry a node the BFF refused for scope, and says why on the card', async () => {
  mocks.run.mockImplementation(async (...args: unknown[]) => {
    const hooks = args[7] as NodeBatchHooks
    const failure = new NodeBatchFailure('failed', 'stage_authorization_scope')
    expect(await hooks.recover?.(plan.jobs[0]!, failure)).toBe('skip')
  })
  await mount('scope-refused', true, { ...proposal, direct: true })
  await act(async () => {})
  expect(preflights).toBe(1)
  expect(reports[0]?.nodes).toEqual([{ nodeId: 'a', outcome: 'failed', reason: 'spec_changed' }])
  expect(document.body.textContent).toContain('有节点的提交内容和你确认时不一致')
})
