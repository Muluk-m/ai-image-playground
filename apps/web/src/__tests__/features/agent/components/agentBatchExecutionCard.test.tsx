// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { setClientStorageScope } from '../../../../lib/authScope'
import { getDeviceId } from '../../../../lib/deviceId'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const estimate = {
  status: 'available' as const,
  estimatedCredits: 14,
  estimatedChargeCredits: 14,
  snapshots: [],
}
function initialPage(): AgentBatchPage {
  return {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'conversation-original',
      originTurnId: 'turn-original',
      experience: 'canvas',
      projectId: 'project-original',
      targetSnapshot: { projectId: 'project-original', projectRevision: 7 },
      version: 1,
      digest: 'a'.repeat(64),
      title: '商品图',
      rule: '逐项换白底',
      itemCount: 2,
      status: 'draft',
      executionEnabled: true,
      submittedCount: 0,
      actualCredits: 0,
      createdAt: 1,
      estimate: {
        analysis: { ...estimate, estimatedCredits: 0, estimatedChargeCredits: 0 },
        generation: estimate,
      },
    },
    items: [0, 1].map((ordinal) => ({
      key: `item-${ordinal}`,
      ordinal,
      kind: 'generation',
      inputs: [
        {
          imageId: `image-${ordinal}`,
          mediaId: `fixture-media-${ordinal}`,
          name: `商品${ordinal + 1}`,
        },
      ],
      prompt: `商品${ordinal + 1}换白底`,
      params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
      dependencies: [],
    })),
    nextCursor: null,
  }
}

it('confirms one fixed batch once, pauses remaining work, and restores the same target before resuming', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  let saved = initialPage()
  const commands: { action: string; body: Record<string, unknown> }[] = []
  let release!: () => void
  const confirming = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      const action = url.split('/').slice(-1)[0]!
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      commands.push({ action, body })
      if (action === 'confirm') {
        await confirming
        saved = {
          ...saved,
          batch: { ...saved.batch, status: 'running', submittedCount: 1 },
          items: saved.items.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  execution: {
                    taskId: 'first-task',
                    status: 'queued',
                    attempt: 1,
                    actualCredits: null,
                  },
                }
              : item,
          ),
        }
      } else if (action === 'pause') {
        saved = { ...saved, batch: { ...saved.batch, status: 'paused' } }
      } else if (action === 'resume') {
        saved = {
          ...saved,
          batch: { ...saved.batch, status: 'running', submittedCount: 2 },
          items: saved.items.map((item, index) =>
            index === 1
              ? {
                  ...item,
                  execution: {
                    taskId: 'second-task',
                    status: 'queued',
                    attempt: 1,
                    actualCredits: null,
                  },
                }
              : item,
          ),
        }
      } else throw new Error(`Unexpected command: ${action}`)
    }
    return Response.json(saved)
  })
  const message = panelMessage('message-original', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-original',
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (one) => one.textContent === label,
    )!
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    expect(host.textContent).toContain('原画布')
    act(() => {
      button('确认生成')!.click()
      button('确认生成')!.click()
    })
    await act(async () => {
      await vi.waitFor(() => expect(commands).toHaveLength(1))
    })
    expect(commands[0]).toEqual({
      action: 'confirm',
      body: {
        commandId: expect.any(String),
        expectedVersion: 1,
        expectedDigest: 'a'.repeat(64),
        deviceId: getDeviceId(),
      },
    })
    await act(async () => {
      release()
    })
    await vi.waitFor(() => expect(button('暂停后续')?.disabled).toBe(false))
    expect(host.textContent).toContain('已提交 1 / 2')
    expect(host.querySelector<HTMLTextAreaElement>('details textarea')!.disabled).toBe(true)
    await act(async () => button('暂停后续')!.click())
    await vi.waitFor(() => expect(button('继续执行')?.disabled).toBe(false))
    expect(commands[1]).toEqual({
      action: 'pause',
      body: { commandId: expect.any(String), expectedVersion: 1 },
    })
    expect(host.textContent).toContain('已暂停')
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.textContent).toContain('已提交 1 / 2'))
    expect(host.textContent).toContain('原画布')
    await vi.waitFor(() => expect(button('继续执行')?.disabled).toBe(false))
    await act(async () => button('继续执行')!.click())
    await vi.waitFor(() => expect(host.textContent).toContain('已提交 2 / 2'))
    expect(commands[2]).toEqual({
      action: 'resume',
      body: {
        commandId: expect.any(String),
        expectedVersion: 1,
        expectedDigest: 'a'.repeat(64),
        deviceId: getDeviceId(),
      },
    })
    expect(new Set(commands.map((command) => command.body.commandId)).size).toBe(3)
    expect(host.textContent).toContain('已提交 2 / 2')
    expect(host.querySelectorAll('details')).toHaveLength(2)
  } finally {
    release()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('restores an uncertain confirmation after reload and checks the exact same command without dispatching twice', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  setClientStorageScope('batch-command-owner')
  let saved = initialPage()
  const commands: Record<string, unknown>[] = []
  const accepted = new Set<string>()
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      expect(url.endsWith('/confirm')).toBe(true)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      commands.push(body)
      accepted.add(String(body.commandId))
      if (commands.length === 1) {
        saved = { ...saved, batch: { ...saved.batch, status: 'running', submittedCount: 1 } }
        // The server committed, but the client never received its receipt.
        throw new TypeError('connection lost after acceptance')
      }
    }
    return Response.json(saved)
  })
  const message = panelMessage('message-uncertain', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-uncertain',
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(button('核对操作结果')).toBeDefined())
    expect(commands).toHaveLength(1)
    expect(button('确认生成')?.disabled ?? true).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    // A GET is current state, not a receipt for our outstanding operation.
    saved = { ...saved, batch: { ...saved.batch, version: 2, digest: 'b'.repeat(64) } }
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('核对操作结果')).toBeDefined())
    expect(host.textContent).toContain('已提交 1 / 2')
    expect(button('暂停后续')?.disabled ?? true).toBe(true)
    await act(async () => button('核对操作结果')!.click())
    await vi.waitFor(() => expect(button('核对操作结果')).toBeUndefined())
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(commands[1]).toMatchObject({
      expectedVersion: 1,
      expectedDigest: 'a'.repeat(64),
      deviceId: getDeviceId(),
    })
    expect(accepted.size).toBe(1)
    expect(button('核对操作结果')).toBeUndefined()
    expect(button('暂停后续')?.disabled).toBe(false)
  } finally {
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})

it('requires a new price review and explicit confirmation while preserving already accepted work', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  let saved = initialPage()
  saved = {
    ...saved,
    batch: {
      ...saved.batch,
      status: 'paused',
      pauseReason: 'price_changed',
      confirmationRequired: false,
      submittedCount: 1,
    },
    items: saved.items.map((item, index) =>
      index === 0
        ? {
            ...item,
            execution: {
              taskId: 'accepted-before-price-change',
              status: 'completed',
              attempt: 1,
              actualCredits: 7,
            },
          }
        : item,
    ),
  }
  const commands: { action: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      const action = url.split('/').slice(-1)[0]!
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      commands.push({ action, body })
      if (action === 'reprice') {
        saved = {
          ...saved,
          batch: {
            ...saved.batch,
            version: 2,
            digest: 'c'.repeat(64),
            confirmationRequired: true,
            estimate: {
              ...saved.batch.estimate,
              generation: { ...estimate, estimatedCredits: 27, estimatedChargeCredits: 27 },
            },
          },
        }
      } else if (action === 'confirm') {
        saved = {
          ...saved,
          batch: {
            ...saved.batch,
            status: 'running',
            pauseReason: null,
            confirmationRequired: false,
            submittedCount: 2,
          },
        }
      } else throw new Error(`Unexpected command: ${action}`)
    }
    return Response.json(saved)
  })
  const message = panelMessage('message-reprice', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-reprice',
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.textContent).toContain('已提交 1 / 2'))
    expect(button('继续执行')).toBeUndefined()
    expect(button('更新报价')?.disabled).toBe(false)
    await act(async () => button('更新报价')!.click())
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    expect(commands).toEqual([
      { action: 'reprice', body: { commandId: expect.any(String), expectedVersion: 1 } },
    ])
    expect(host.textContent).toContain('27')
    expect(host.textContent).toContain('版本 2')
    expect(host.textContent).toContain('已提交 1 / 2')
    expect(saved.items[0]?.execution?.taskId).toBe('accepted-before-price-change')
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(button('暂停后续')?.disabled).toBe(false))
    expect(commands[1]).toEqual({
      action: 'confirm',
      body: {
        commandId: expect.any(String),
        expectedVersion: 2,
        expectedDigest: 'c'.repeat(64),
        deviceId: getDeviceId(),
      },
    })
    expect(commands[0]?.body.commandId).not.toBe(commands[1]?.body.commandId)
    expect(host.textContent).toContain('已提交 2 / 2')
    expect(saved.items[0]?.execution?.taskId).toBe('accepted-before-price-change')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  401, 403, 429,
])('keeps the original uncertain command when receipt lookup receives HTTP %i', async (status) => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const saved = initialPage()
  const commands: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${input}`)
    if (init?.method === 'POST') {
      commands.push(JSON.parse(String(init.body)))
      if (commands.length === 1) throw new TypeError('receipt lost')
      if (commands.length === 2)
        return Response.json({ error: 'temporarily_unavailable' }, { status })
    }
    return Response.json(
      commands.length >= 3
        ? { ...saved, batch: { ...saved.batch, status: 'running', submittedCount: 1 } }
        : saved,
    )
  })
  const message = panelMessage(`message-${status}`, 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: `call-${status}`,
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(button('核对操作结果')?.disabled).toBe(false))
    await act(async () => button('核对操作结果')!.click())
    await vi.waitFor(() => expect(commands).toHaveLength(2))
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.querySelector('details')).not.toBeNull())
    expect(button('核对操作结果')?.disabled).toBe(false)
    await act(async () => button('核对操作结果')!.click())
    await vi.waitFor(() => expect(button('暂停后续')?.disabled).toBe(false))
    expect(commands).toHaveLength(3)
    expect(commands[1]).toEqual(commands[0])
    expect(commands[2]).toEqual(commands[0])
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('polls one active batch at a time, exposes each outcome, and stops after its terminal snapshot', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }))
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  let saved = initialPage()
  saved = {
    ...saved,
    batch: { ...saved.batch, status: 'running', submittedCount: 2 },
    items: saved.items.map((item, index) => ({
      ...item,
      execution: {
        taskId: `progress-task-${index}`,
        status: 'queued',
        attempt: 1,
        actualCredits: null,
      },
    })),
  }
  let reads = 0
  let imageReads = 0
  let release!: () => void
  const slowRead = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/queue/requests/progress-task-0/image/0')) {
      imageReads++
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    }
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    expect(init?.method ?? 'GET').toBe('GET')
    reads++
    if (reads === 2) await slowRead
    return Response.json(saved)
  })
  const message = panelMessage('message-progress', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-progress',
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    vi.useFakeTimers()
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.querySelectorAll('details')).toHaveLength(2))
    // A slow read occupies the only poll slot, even across several normal intervals.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads).toBe(2)
    saved = {
      ...saved,
      items: saved.items.map((item, index) => ({
        ...item,
        execution:
          index === 0
            ? {
                taskId: 'progress-task-0',
                status: 'completed',
                attempt: 1,
                actualCredits: 7,
                artifacts: [
                  {
                    artifactId: 'batch-output-0',
                    taskId: 'progress-task-0',
                    outputIndex: 0,
                    media: 'image',
                    mime: 'image/png',
                  },
                ],
              }
            : { taskId: 'progress-task-1', status: 'reconciling', attempt: 1, actualCredits: null },
      })),
    }
    await act(async () => {
      release()
    })
    expect(host.querySelectorAll('details')[0]?.textContent).toContain('已完成')
    expect(host.querySelectorAll('details')[1]?.textContent).toContain('待核查')
    expect(imageReads).toBe(0)
    saved = {
      ...saved,
      batch: { ...saved.batch, status: 'closed', actualCredits: 7 },
      items: saved.items.map((item, index) =>
        index === 0
          ? item
          : {
              ...item,
              execution: {
                taskId: 'progress-task-1',
                status: 'failed',
                attempt: 1,
                actualCredits: 0,
                errorCode: 'content_policy',
                message: 'raw upstream text must not leak',
              },
            },
      ),
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads).toBe(3)
    expect(host.querySelectorAll('details')[1]?.textContent).toContain('生成失败')
    expect(host.textContent).not.toContain('raw upstream text')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(reads).toBe(3)
    vi.useRealTimers()
    act(() => host.querySelector('summary')!.click())
    const preview = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (one) => one.textContent === '查看结果 1',
    )
    expect(preview).toBeDefined()
    await act(async () => preview!.click())
    await vi.waitFor(() =>
      expect(document.querySelector('img[src^="data:image/png"]')).not.toBeNull(),
    )
    expect(imageReads).toBe(1)
  } finally {
    release()
    vi.useRealTimers()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('keeps the newly opened batch when the previous batch control response arrives late', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const first = initialPage()
  let second = initialPage()
  second = { ...second, batch: { ...second.batch, title: '新会话批次' } }
  let release!: () => void
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  let posted = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes(`/api/agent/batches/${second.batch.id}`)) {
      expect(init?.method ?? 'GET').toBe('GET')
      return Response.json(second)
    }
    if (!url.includes(`/api/agent/batches/${first.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      posted = true
      await delayed
      return Response.json({
        ...first,
        batch: { ...first.batch, status: 'running', submittedCount: 1 },
      })
    }
    return Response.json(first)
  })
  const message = (page: AgentBatchPage) => {
    const result = panelMessage(page.batch.id, 'turn-original', 'assistant', [
      {
        type: 'toolResult',
        toolName: 'planImageBatch',
        toolCallId: page.batch.id,
        title: page.batch.title,
        status: 'succeeded',
        batchId: page.batch.id,
      },
    ])
    if (result.kind !== 'tool') throw new Error('expected tool card')
    return result
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message(first)} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(posted).toBe(true))
    await act(async () => root.render(<AgentToolCard message={message(second)} />))
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('新会话批次'),
    )
    // Let the response and its durable receipt cleanup finish, without remounting the new card.
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('新会话批次')
    expect(button('确认生成')?.disabled).toBe(false)
    expect(button('暂停后续')).toBeUndefined()
  } finally {
    release()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('quotes only selected definite failures and preserves pause plus every earlier attempt when confirming a retry', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  let saved = initialPage()
  const failed = {
    taskId: 'failed-original-task',
    status: 'failed' as const,
    attempt: 1,
    actualCredits: 0,
    errorCode: 'content_policy',
  }
  saved = {
    ...saved,
    batch: {
      ...saved.batch,
      status: 'paused',
      itemCount: 4,
      submittedCount: 3,
      confirmationRequired: false,
    },
    items: [
      {
        ...saved.items[0]!,
        progress: 'completed',
        execution: {
          taskId: 'successful-original-task',
          status: 'completed',
          attempt: 1,
          actualCredits: 7,
        },
      },
      { ...saved.items[1]!, progress: 'failed', execution: failed, attempts: [failed] },
      {
        ...saved.items[0]!,
        key: 'item-2',
        ordinal: 2,
        progress: 'reconciling',
        execution: {
          taskId: 'uncertain-original-task',
          status: 'reconciling',
          attempt: 1,
          actualCredits: null,
        },
      },
      {
        ...saved.items[0]!,
        key: 'item-3',
        ordinal: 3,
        dependencies: ['item-1'],
        progress: 'blocked',
        blockedBy: ['item-1'],
      },
    ],
  }
  const commands: { action: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      const action = url.split('/').slice(-1)[0]!
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      commands.push({ action, body })
      if (action === 'retry-quote') {
        saved = {
          ...saved,
          batch: {
            ...saved.batch,
            version: 2,
            digest: 'd'.repeat(64),
            confirmationRequired: true,
            retryItemKeys: ['item-1'],
            retryRequiresResume: true,
            estimate: {
              ...saved.batch.estimate,
              generation: { ...estimate, estimatedCredits: 19, estimatedChargeCredits: 19 },
            },
          },
        }
        saved = {
          ...saved,
          items: saved.items.map((item) =>
            item.key === 'item-1'
              ? { ...item, progress: 'ready' }
              : item.key === 'item-3'
                ? { ...item, progress: 'pending', blockedBy: [] }
                : item,
          ),
        }
      } else if (action === 'confirm') {
        saved = { ...saved, batch: { ...saved.batch, confirmationRequired: false } }
      } else if (action === 'resume') {
        const retry = {
          taskId: 'retry-task',
          status: 'queued' as const,
          attempt: 2,
          actualCredits: null,
        }
        saved = {
          ...saved,
          batch: { ...saved.batch, status: 'running' },
          items: saved.items.map((item) =>
            item.key === 'item-1'
              ? { ...item, progress: 'in_flight', execution: retry, attempts: [failed, retry] }
              : item,
          ),
        }
      } else throw new Error(`Unexpected command: ${action}`)
    }
    return Response.json(saved)
  })
  const message = panelMessage('message-retry', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-retry',
      title: '商品图',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.querySelectorAll('details')).toHaveLength(4))
    expect(host.querySelectorAll('details')[3]?.textContent).toContain('依赖受阻')
    expect(host.querySelectorAll('details')[3]?.textContent).toContain('第 2 项')
    act(() => host.querySelectorAll('details')[1]!.querySelector('summary')!.click())
    const selection = host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
    expect(selection).toHaveLength(1)
    expect(selection[0]?.getAttribute('aria-label')).toBe('选择重试第 2 项')
    act(() => selection[0]!.click())
    await act(async () => button('获取重试报价')!.click())
    await vi.waitFor(() => expect(button('确认重试')?.disabled).toBe(false))
    expect(commands).toEqual([
      {
        action: 'retry-quote',
        body: { commandId: expect.any(String), expectedVersion: 1, itemKeys: ['item-1'] },
      },
    ])
    expect(
      [...host.querySelectorAll('details > summary')].filter((row) =>
        row.textContent?.includes('本次重试'),
      ),
    ).toHaveLength(1)
    expect(host.textContent).toContain('本次重试预估')
    expect(host.textContent).toContain('19')
    expect(host.textContent).toContain('确认后批次仍暂停')
    expect(saved.items[0]?.execution?.taskId).toBe('successful-original-task')
    expect(saved.items[1]?.execution?.taskId).toBe('failed-original-task')
    await act(async () => button('确认重试')!.click())
    await vi.waitFor(() => expect(button('继续执行')?.disabled).toBe(false))
    expect(commands[1]).toEqual({
      action: 'confirm',
      body: {
        commandId: expect.any(String),
        expectedVersion: 2,
        expectedDigest: 'd'.repeat(64),
        deviceId: getDeviceId(),
      },
    })
    expect(host.textContent).toContain('已确认，批次已暂停')
    expect(saved.items[1]?.execution?.taskId).toBe('failed-original-task')
    await act(async () => button('继续执行')!.click())
    await vi.waitFor(() => expect(button('暂停后续')?.disabled).toBe(false))
    expect(commands[2]).toMatchObject({
      action: 'resume',
      body: { expectedVersion: 2, expectedDigest: 'd'.repeat(64) },
    })
    expect(saved.items[0]?.execution).toMatchObject({
      taskId: 'successful-original-task',
      actualCredits: 7,
    })
    const retriedItem = [...host.querySelectorAll('details')].find((item) =>
      item.textContent?.includes('第 2 次'),
    )!
    expect(retriedItem.textContent).toContain('第 1 次')
    expect(retriedItem.textContent).toContain('生成失败')
    expect(retriedItem.textContent).toContain('排队中')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('reviews analysis inputs without image-generation controls and displays findings with explicit coverage and settled cost', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  let saved = initialPage()
  const evidence = [
    {
      imageId: 'image-0',
      width: 8,
      height: 6,
      bytes: 58,
      source: 'analysis' as const,
      representation: 'preview' as const,
      selection: false,
    },
  ]
  saved = {
    ...saved,
    batch: {
      ...saved.batch,
      experience: 'chat',
      projectId: null,
      targetSnapshot: { projectId: null, projectRevision: null },
      itemCount: 1,
      estimate: {
        analysis: { ...estimate, estimatedCredits: 3, estimatedChargeCredits: 3 },
        generation: { ...estimate, estimatedCredits: 0, estimatedChargeCredits: 0 },
      },
    },
    items: [
      {
        key: 'analysis-1',
        ordinal: 0,
        kind: 'analysis',
        inputs: [...saved.items[0]!.inputs, ...saved.items[1]!.inputs],
        prompt: '逐图检查颜色',
        params: { model: 'analysis-model', estimatedInputTokens: 900, evidence },
        dependencies: [],
      },
    ],
  }
  const commands: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${saved.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { items: { prompt: string; params: unknown }[] }
      expect(body.items[0]?.params).toEqual({ model: 'analysis-model' })
      expect(body.items[0]?.prompt).toBe('检查色彩与划痕')
      saved = {
        ...saved,
        batch: {
          ...saved.batch,
          version: 2,
          digest: 'e'.repeat(64),
          estimate: {
            ...saved.batch.estimate,
            analysis: { ...estimate, estimatedCredits: 4, estimatedChargeCredits: 4 },
          },
        },
        items: saved.items.map((item) => ({ ...item, prompt: body.items[0]!.prompt })),
      }
    }
    if (init?.method === 'POST') {
      expect(url.endsWith('/confirm')).toBe(true)
      commands.push(JSON.parse(String(init.body)))
      saved = {
        ...saved,
        batch: { ...saved.batch, status: 'closed', submittedCount: 1, actualCredits: 1 },
        items: saved.items.map((item) => ({
          ...item,
          progress: 'completed',
          execution: {
            taskId: 'analysis-task',
            status: 'completed',
            attempt: 1,
            actualCredits: 1,
            artifacts: [],
            analysis: {
              findings: [{ imageId: 'image-0', text: '颜色均匀' }],
              coverage: {
                requiredImageIds: ['image-0', 'image-1'],
                reviewedImageIds: ['image-0'],
                missingImageIds: ['image-1'],
              },
              evidence,
            },
          },
        })),
      }
    }
    return Response.json(saved)
  })
  const message = panelMessage('message-analysis', 'turn-original', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-analysis',
      title: '图片检查',
      status: 'succeeded',
      batchId: saved.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.querySelector('details')).not.toBeNull())
    act(() => host.querySelector('summary')!.click())
    expect(host.querySelector('input[aria-label="尺寸"]')).toBeNull()
    expect(host.textContent).toContain('图像分析')
    expect(host.textContent).toContain('analysis-model')
    expect(host.textContent).toContain('预览')
    expect(button('确认执行')?.disabled).toBe(false)
    const prompt = host.querySelector<HTMLTextAreaElement>('details textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        prompt,
        '检查色彩与划痕',
      )
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('确认执行')?.disabled).toBe(true)
    await act(async () => button('保存计划')!.click())
    await vi.waitFor(() => expect(host.textContent).toContain('版本 2'))
    expect(host.querySelector('[aria-label="4 积分"]')).not.toBeNull()
    await act(async () => button('确认执行')!.click())
    await vi.waitFor(() => expect(host.textContent).toContain('颜色均匀'))
    expect(commands).toEqual([
      {
        commandId: expect.any(String),
        expectedVersion: 2,
        expectedDigest: 'e'.repeat(64),
        deviceId: getDeviceId(),
      },
    ])
    expect(host.textContent).toContain('已检查 1 / 2')
    expect(host.textContent).toContain('未覆盖：商品2')
    expect(host.querySelector('[aria-label="1 积分"]')).not.toBeNull()
    expect(button('查看结果 1')).toBeUndefined()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
