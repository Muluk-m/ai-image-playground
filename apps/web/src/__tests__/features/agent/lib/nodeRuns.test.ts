// @vitest-environment jsdom

import type { AgentCanvasRunProposal, StageAuthorization } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerAgentNodeRun } from '../../../../features/agent/lib/nodeRunBridge'
import {
  agentNodeRun,
  createAgentNodeRunView,
  forgetAgentNodeRun,
  isAgentNodeRunOrigin,
  registerAgentNodeRunOrigin,
  releaseIdleAgentNodeRunOrigins,
} from '../../../../features/agent/lib/nodeRuns'
import {
  executeNodeBatch,
  NodeBatchFailure,
  type NodeBatchPlan,
} from '../../../../features/canvas/lib/nodeBatch'
import { setClientStorageScope } from '../../../../lib/authScope'
import { useStore } from '../../../../store'

vi.mock('../../../../lib/channels/bootstrapChannels', () => ({ refreshChannels: async () => {} }))

const proposal: AgentCanvasRunProposal = {
  projectId: 'project',
  nodeIds: ['a'],
  nodeNames: ['A'],
  authorizationId: 'authorization',
  stage: '素材',
  estimatedCredits: 20,
  budgetCap: 40,
  status: 'pending',
}
let authorization: StageAuthorization
let plan: NodeBatchPlan
let requests: string[]
let reports: { nodes: unknown[] }[]
let preflight: () => Promise<void>
let readAuthorization: () => Promise<StageAuthorization>
let submit: ReturnType<typeof vi.fn<() => Promise<void>>>
let disconnect: () => void
let disposals: (() => void)[]
let keys: string[]
const flush = () => vi.advanceTimersByTimeAsync(0)
function observe(key: string, origin = true) {
  keys.push(key)
  if (origin) registerAgentNodeRunOrigin(key)
  const view = createAgentNodeRunView(key, proposal)
  const unsubscribe = view.subscribe(() => {})
  disposals.push(unsubscribe)
  return { view, unsubscribe }
}
beforeEach(() => {
  vi.useFakeTimers()
  setClientStorageScope('lifecycle-test')
  requests = []
  reports = []
  disposals = []
  keys = []
  authorization = {
    id: 'authorization',
    conversationId: 'conversation',
    projectId: 'project',
    stage: '素材',
    nodeIds: ['a'],
    nodeNames: ['A'],
    estimatedCredits: 20,
    budgetCap: 40,
    spentCredits: 0,
    status: 'pending',
    attempts: [],
    audit: [],
  }
  plan = {
    signature: 'same',
    credits: 20,
    jobs: [
      {
        id: 'a',
        label: 'A',
        kind: 'image',
        model: 'fixture',
        quantity: 1,
        prompt: 'A',
        refs: [],
        roles: {},
        temporary: {},
        dependencies: [],
      },
    ],
    settings: useStore.getState().settings,
    params: useStore.getState().params,
  }
  preflight = async () => {}
  readAuthorization = async () => authorization
  submit = vi.fn(async () => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const action = String(input).split('/').pop()!
      requests.push(action)
      if (action === 'confirm') {
        authorization = {
          ...authorization,
          status: 'active',
          audit: [{ kind: 'confirmed', at: Date.now() }],
        }
        return Response.json({ authorization, executionToken: 'token' })
      }
      if (action === 'preflight') {
        await preflight()
        return Response.json(authorization)
      }
      if (action === 'report') {
        reports.push(JSON.parse(String(init?.body)))
        authorization = { ...authorization, status: 'ended' }
        return Response.json({ authorization, wake: 'queued' })
      }
      if (action === 'end') {
        authorization = { ...authorization, status: 'ended' }
        return Response.json(authorization)
      }
      return Response.json(await readAuthorization())
    }),
  )
  disconnect = registerAgentNodeRun({
    projectId: 'project',
    quote: () => plan,
    run: (_proposal, captured, execution) =>
      executeNodeBatch(captured, {
        ...execution.hooks,
        signal: execution.signal,
        progress: execution.progress,
        current: () => plan,
        submit,
      }),
  })
})
afterEach(async () => {
  for (const dispose of disposals) dispose()
  disconnect()
  for (const key of keys) forgetAgentNodeRun(key)
  await flush()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([
  ['stage_authorization_scope', 'spec_changed'],
  ['stage_authorization_attempt_conflict', 'spec_changed'],
  ['stage_authorization_budget', 'budget_exceeded'],
  ['stage_authorization_retry_limit', 'retry_limit'],
  ['stage_authorization_inactive', 'authorization'],
  ['stage_authorization_not_found', 'authorization'],
  ['stage_authorization_stale', 'authorization'],
])('reports %s without spending a retry', async (code, reason) => {
  submit.mockRejectedValue(new NodeBatchFailure('failed', code))
  const { view } = observe(code)
  expect(view.start()).toBe(true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(requests.filter((action) => action === 'preflight')).toHaveLength(1)
  expect(reports).toEqual([
    expect.objectContaining({ nodes: [{ nodeId: 'a', outcome: 'failed', reason }] }),
  ])
  expect(view.getSnapshot().run?.report?.wake).toBe('queued')
  expect(agentNodeRun(code)).toBeUndefined()
})

it.each([
  'stage_authorization_node_already_started',
  'stage_authorization_something_new',
  'quota_exceeded',
  undefined,
])('preserves the one retry for an unrecognized failure %s', async (code) => {
  submit.mockRejectedValue(new NodeBatchFailure('failed', code))
  const { view } = observe('retry')
  view.start()
  await vi.advanceTimersByTimeAsync(5000)
  expect(submit).toHaveBeenCalledTimes(2)
  expect(requests.filter((action) => action === 'preflight')).toHaveLength(2)
  expect(reports[0]?.nodes).toEqual([
    { nodeId: 'a', outcome: 'failed', reason: 'generation_failed', retried: true },
  ])
})

it('keeps confirming and reports once after the last view disconnects and conversation switches', async () => {
  let confirm!: () => void
  const ready = new Promise<void>((resolve) => {
    confirm = resolve
  })
  const fetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/confirm')) await ready
      return fetch(input, init)
    }),
  )
  const { view, unsubscribe } = observe('detached')
  view.start()
  unsubscribe()
  releaseIdleAgentNodeRunOrigins()
  expect(isAgentNodeRunOrigin('detached')).toBe(true)
  confirm()
  await vi.advanceTimersByTimeAsync(5000)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(reports).toHaveLength(1)
  expect(agentNodeRun('detached')).toBeUndefined()
  expect(isAgentNodeRunOrigin('detached')).toBe(false)
})

it.each([
  'initial',
  'retry',
])('does not submit after switching accounts during %s preflight', async (phase) => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let count = 0
  preflight = async () => {
    count += 1
    if (count === (phase === 'initial' ? 1 : 2)) await pending
  }
  if (phase === 'retry') submit.mockRejectedValueOnce(new NodeBatchFailure('failed'))
  const { view } = observe('switched')
  view.start()
  await vi.advanceTimersByTimeAsync(5000)
  setClientStorageScope('other-account')
  finish()
  await flush()
  expect(submit).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1)
  expect(reports).toHaveLength(0)
  expect(agentNodeRun('switched')).toBeUndefined()
  expect(view.getSnapshot().run).toBeUndefined()
})

it('does not publish an authorization read from a disconnected subscription', async () => {
  let finish!: (state: StageAuthorization) => void
  readAuthorization = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const { view, unsubscribe } = observe('late-read', false)
  unsubscribe()
  finish({ ...authorization, status: 'ended' })
  await flush()
  expect(view.getSnapshot().readReady).toBe(false)
  readAuthorization = async () => authorization
  disposals.push(view.subscribe(() => {}))
  await flush()
  expect(view.getSnapshot().authorization?.status).toBe('pending')
  expect(view.getSnapshot().canConfirm).toBe(false)
  expect(view.start()).toBe(false)
})

it('shares one polling loop across subscribers and restarts after a manual retry', async () => {
  readAuthorization = async () => {
    throw new TypeError('offline')
  }
  const { view, unsubscribe } = observe('polling', false)
  const second = view.subscribe(() => {})
  disposals.push(second)
  await vi.advanceTimersByTimeAsync(45000)
  expect(requests).toHaveLength(5)
  expect(view.getSnapshot().readFailed).toBe(true)
  readAuthorization = async () => authorization
  view.retryRead()
  await flush()
  expect(view.getSnapshot().readFailed).toBe(false)
  expect(view.getSnapshot().readReady).toBe(true)
  unsubscribe()
  await vi.advanceTimersByTimeAsync(3000)
  expect(requests).toHaveLength(7)
  second()
  await vi.advanceTimersByTimeAsync(6000)
  expect(requests).toHaveLength(7)
})

it('stops future submissions without reporting or waking the agent', async () => {
  let finish!: () => void
  preflight = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const { view } = observe('stop')
  view.start()
  await vi.advanceTimersByTimeAsync(5000)
  view.stop()
  finish()
  await flush()
  expect(submit).not.toHaveBeenCalled()
  expect(reports).toHaveLength(0)
  expect(requests).toContain('end')
})

it('keeps unconfirmed origins until the conversation state has been cleared', () => {
  for (let index = 0; index < 201; index += 1) {
    const key = `origin-cap-${index}`
    keys.push(key)
    registerAgentNodeRunOrigin(key)
  }
  expect(isAgentNodeRunOrigin('origin-cap-0')).toBe(true)
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(true)
  releaseIdleAgentNodeRunOrigins()
  expect(isAgentNodeRunOrigin('origin-cap-0')).toBe(false)
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(false)
})

it.each([
  ['stage_authorization_budget', 'budget_exceeded'],
  ['stage_authorization_inactive', 'authorization'],
])('reports retry preflight refusal %s without another submission', async (code, reason) => {
  submit.mockImplementation(async () => {
    preflight = async () => { throw new Error(code) }
    throw new NodeBatchFailure('failed')
  })
  const { view } = observe('refused-retry')
  view.start()
  await vi.advanceTimersByTimeAsync(5000)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(requests.filter((action) => action === 'preflight')).toHaveLength(2)
  expect(reports[0]?.nodes).toEqual([{ nodeId: 'a', outcome: 'failed', reason }])
})

it('does not report if a pending retry preflight rejects after stop', async () => {
  let reject!: (error: Error) => void
  submit.mockImplementation(async () => {
    preflight = () => new Promise((_resolve, fail) => { reject = fail })
    throw new NodeBatchFailure('failed')
  })
  const { view } = observe('stop-retry')
  view.start()
  await vi.advanceTimersByTimeAsync(5000)
  view.stop()
  reject(new Error('stage_authorization_inactive'))
  await flush()
  expect(submit).toHaveBeenCalledTimes(1)
  expect(reports).toHaveLength(0)
  expect(requests).toContain('end')
})
