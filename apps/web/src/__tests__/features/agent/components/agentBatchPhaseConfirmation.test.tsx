// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage, AgentBatchUpdate } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { getDeviceId } from '../../../../lib/deviceId'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('requires a separate generation confirmation after paid analysis, retaining the settled analysis on reload', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const zero = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  let page: AgentBatchPage = {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'original-chat',
      originTurnId: 'original-turn',
      projectId: 'original-project',
      experience: 'chat',
      targetSnapshot: { projectId: 'original-project', projectRevision: null },
      version: 2,
      digest: 'g'.repeat(64),
      title: '根据检查生成改进图',
      rule: '只生成已确认的改进图',
      itemCount: 1,
      status: 'paused',
      confirmationRequired: true,
      confirmation: { phase: 'generation', itemKeys: ['generate-new'], requiresResume: false },
      executionEnabled: true,
      submittedCount: 0,
      actualCredits: 3,
      estimate: {
        analysis: zero,
        generation: { ...zero, estimatedCredits: 19, estimatedChargeCredits: 19 },
      },
      createdAt: 1,
    },
    items: [
      {
        key: 'generate-new',
        ordinal: 0,
        kind: 'generation',
        prompt: '修正商品边缘',
        inputs: [{ imageId: 'original', mediaId: 'media-original', name: '原商品' }],
        dependencies: [],
        params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
        progress: 'pending',
      },
    ],
    nextCursor: null,
  }
  const commands: { action: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      commands.push({ action: url.split('/').slice(-1)[0]!, body: JSON.parse(String(init.body)) })
      page = {
        ...page,
        batch: { ...page.batch, status: 'running', confirmationRequired: false, submittedCount: 1 },
        items: page.items.map((item) =>
          item.key === 'generate-new'
            ? {
                ...item,
                progress: 'in_flight',
                execution: {
                  taskId: 'new-generation-task',
                  status: 'queued',
                  attempt: 1,
                  actualCredits: null,
                },
              }
            : item,
        ),
      }
    }
    return Response.json(page)
  })
  const message = panelMessage('phase-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'proposeBatchGeneration',
      toolCallId: 'phase-call',
      title: page.batch.title,
      status: 'succeeded',
      batchId: page.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    expect(button('继续执行')).toBeUndefined()
    expect(host.querySelector('[aria-label="19 积分"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="3 积分"]')).not.toBeNull()
    expect(commands).toEqual([])
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    expect(commands).toEqual([])
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      action: 'confirm',
      body: {
        commandId: expect.any(String),
        expectedVersion: 2,
        expectedDigest: 'g'.repeat(64),
        deviceId: getDeviceId(),
      },
    })
    expect(page.batch.actualCredits).toBe(3)
    expect(page.items[0]?.execution).toMatchObject({
      taskId: 'new-generation-task',
      attempt: 1,
      actualCredits: null,
    })
    expect(host.querySelector('[aria-label="3 积分"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('shows the exact source analysis and excluded images before confirming a reduced generation scope', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const quote = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  const page: AgentBatchPage = {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'original-chat',
      originTurnId: 'original-turn',
      projectId: 'original-project',
      experience: 'chat',
      targetSnapshot: { projectId: 'original-project', projectRevision: null },
      version: 2,
      digest: 's'.repeat(64),
      title: '只处理已检查的第一张',
      rule: '保留未确认项供后续核查',
      itemCount: 1,
      status: 'paused',
      confirmationRequired: true,
      executionEnabled: true,
      actualCredits: 3,
      createdAt: 1,
      confirmation: {
        phase: 'generation',
        itemKeys: ['generate-a'],
        sourceVersion: 1,
        excludedItemKeys: ['inspect-b'],
        excludedImageIds: ['b'],
        requiresResume: false,
      },
      estimate: {
        analysis: quote,
        generation: { ...quote, estimatedCredits: 19, estimatedChargeCredits: 19 },
      },
    },
    items: [
      {
        key: 'generate-a',
        ordinal: 0,
        kind: 'generation',
        prompt: '修复第一张边缘',
        inputs: [{ imageId: 'a', mediaId: 'media-a', name: '商品甲' }],
        dependencies: [],
        sourceAnalysis: [{ itemKey: 'inspect-a', taskId: 'verified-analysis-a', attempt: 2 }],
        params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
      },
    ],
    nextCursor: null,
    sourceAnalysisSummary: {
      complete: false,
      inspectionComplete: false,
      jointComparisons: [],
      requiredImageIds: ['a', 'b'],
      successfulImageIds: ['a'],
      missingImageIds: ['b'],
      unresolvedItemKeys: ['inspect-b'],
      findings: [
        {
          imageId: 'a',
          text: '第二次分析证实边缘有缺口',
          itemKey: 'inspect-a',
          taskId: 'verified-analysis-a',
          attempt: 2,
          evidence: [
            {
              imageId: 'a',
              width: 8,
              height: 6,
              bytes: 100,
              source: 'analysis',
              representation: 'preview',
              selection: false,
            },
          ],
        },
      ],
    },
  }
  const posts: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') posts.push(url)
    return Response.json(page)
  })
  const message = panelMessage('source-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'proposeBatchGeneration',
      toolCallId: 'source-call',
      title: page.batch.title,
      status: 'succeeded',
      batchId: page.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.querySelector('details')).not.toBeNull())
    expect(host.textContent).toContain('来源分析 · 版本 1')
    expect(host.textContent).toContain('图片覆盖 1 / 2')
    act(() =>
      host.querySelector<HTMLElement>('section[aria-label="来源分析 · 版本 1"] summary')!.click(),
    )
    expect(
      host.querySelector('section[aria-label="来源分析 · 版本 1"] details')?.hasAttribute('open'),
    ).toBe(true)
    expect(host.textContent).toContain('第二次分析证实边缘有缺口')
    expect(host.textContent).toContain('第 2 次')
    expect(host.textContent).toContain('本次不包含')
    expect(host.textContent).toContain('输入图 2')
    expect(host.textContent).not.toContain('分析已完成')
    expect(
      [...host.querySelectorAll('button')].find((button) => button.textContent === '确认生成')
        ?.disabled,
    ).toBe(false)
    expect(posts).toEqual([])
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('re-quotes an edited pending generation phase and confirms only its new version without rewriting analysis provenance', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const zero = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  let page: AgentBatchPage = {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'original-chat',
      originTurnId: 'original-turn',
      projectId: 'original-project',
      experience: 'chat',
      targetSnapshot: { projectId: 'original-project', projectRevision: null },
      version: 2,
      digest: 'e'.repeat(64),
      title: '分析后生成',
      rule: '修复确定的缺陷',
      itemCount: 1,
      status: 'paused',
      confirmationRequired: true,
      executionEnabled: true,
      actualCredits: 3,
      createdAt: 1,
      confirmation: {
        phase: 'generation',
        itemKeys: ['generate-a'],
        sourceVersion: 1,
        requiresResume: false,
      },
      estimate: {
        analysis: zero,
        generation: { ...zero, estimatedCredits: 19, estimatedChargeCredits: 19 },
      },
    },
    items: [
      {
        key: 'generate-a',
        ordinal: 0,
        kind: 'generation',
        prompt: '修复边缘',
        inputs: [{ imageId: 'a', mediaId: 'media-a', name: '商品甲' }],
        dependencies: [],
        sourceAnalysis: [{ itemKey: 'inspect-a', taskId: 'paid-analysis-a', attempt: 2 }],
        params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
      },
    ],
    nextCursor: null,
  }
  const patches: AgentBatchUpdate[] = []
  const confirms: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'PATCH') {
      const patch: AgentBatchUpdate = JSON.parse(String(init.body))
      patches.push(patch)
      page = {
        ...page,
        batch: {
          ...page.batch,
          version: 3,
          digest: 'f'.repeat(64),
          estimate: {
            analysis: zero,
            generation: { ...zero, estimatedCredits: 24, estimatedChargeCredits: 24 },
          },
        },
        items: page.items.map((item) => ({ ...item, prompt: patch.items[0]!.prompt })),
      }
    }
    if (init?.method === 'POST') {
      expect(url.endsWith('/confirm')).toBe(true)
      confirms.push(JSON.parse(String(init.body)))
      page = { ...page, batch: { ...page.batch, status: 'running', confirmationRequired: false } }
    }
    return Response.json(page)
  })
  const message = panelMessage('edit-phase-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'proposeBatchGeneration',
      toolCallId: 'edit-phase-call',
      title: page.batch.title,
      status: 'succeeded',
      batchId: page.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((one) => one.textContent === label)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    const prompt = host.querySelector<HTMLTextAreaElement>('details textarea')!
    expect(prompt.disabled).toBe(false)
    act(() => {
      host
        .querySelector('details summary')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        prompt,
        '修复边缘但保留原有纹理',
      )
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('确认生成')?.disabled).toBe(true)
    expect(confirms).toEqual([])
    await act(async () => button('保存计划')!.click())
    await vi.waitFor(() => expect(host.textContent).toContain('版本 3'))
    expect(patches[0]).toMatchObject({
      expectedVersion: 2,
      items: [{ key: 'generate-a', prompt: '修复边缘但保留原有纹理' }],
    })
    expect(patches[0]?.items[0]).not.toHaveProperty('sourceAnalysis')
    expect(page.items[0]).toHaveProperty('sourceAnalysis', [
      { itemKey: 'inspect-a', taskId: 'paid-analysis-a', attempt: 2 },
    ])
    expect(host.querySelector('[aria-label="24 积分"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="3 积分"]')).not.toBeNull()
    expect(confirms).toEqual([])
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(confirms).toHaveLength(1))
    expect(confirms[0]).toMatchObject({
      expectedVersion: 3,
      expectedDigest: 'f'.repeat(64),
      commandId: expect.any(String),
    })
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
