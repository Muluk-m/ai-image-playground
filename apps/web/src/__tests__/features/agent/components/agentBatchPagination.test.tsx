// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage, AgentBatchUpdate } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { setClientStorageScope } from '../../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('reviews 100 items in 20-item pages, restores the page on reload, and saves and confirms the complete scope', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  setClientStorageScope('batch-pagination-owner')
  const quote = {
    status: 'available' as const,
    estimatedCredits: 100,
    estimatedChargeCredits: 100,
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
      version: 1,
      digest: 'a'.repeat(64),
      title: '一百件商品',
      rule: '保留每件商品的原样',
      itemCount: 100,
      status: 'draft',
      executionEnabled: true,
      estimate: {
        analysis: { ...quote, estimatedCredits: 0, estimatedChargeCredits: 0 },
        generation: quote,
      },
      createdAt: 1,
    },
    items: Array.from({ length: 100 }, (_, ordinal) => ({
      key: `item-${ordinal}`,
      ordinal,
      kind: 'generation',
      prompt: `商品 ${ordinal + 1} 原样`,
      inputs: [
        { imageId: `image-${ordinal}`, mediaId: `media-${ordinal}`, name: `商品 ${ordinal + 1}` },
      ],
      dependencies: [],
      params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
    })),
    nextCursor: null,
  }
  const patches: AgentBatchUpdate[] = []
  const commands: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'PATCH') {
      const patch: AgentBatchUpdate = JSON.parse(String(init.body))
      patches.push(patch)
      page = {
        ...page,
        batch: { ...page.batch, version: 2, digest: 'b'.repeat(64) },
        items: page.items.map((item) => ({
          ...item,
          prompt: patch.items.find((next) => next.key === item.key)!.prompt,
        })),
      }
    }
    if (init?.method === 'POST') {
      expect(url.endsWith('/confirm')).toBe(true)
      commands.push(JSON.parse(String(init.body)))
      page = { ...page, batch: { ...page.batch, status: 'running', submittedCount: 100 } }
    }
    return Response.json(page)
  })
  const message = panelMessage('pagination-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'pagination-call',
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
    await vi.waitFor(() => expect(host.querySelectorAll('details')).toHaveLength(20))
    expect(host.textContent).toContain('1 / 5')
    expect(host.querySelector('details summary')?.textContent).toContain('商品 1')
    act(() => button('下一页')!.click())
    expect(host.textContent).toContain('2 / 5')
    expect(host.querySelector('details summary')?.textContent).toContain('商品 21')
    expect(host.querySelectorAll('details')).toHaveLength(20)
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() => expect(host.textContent).toContain('2 / 5'))
    expect(host.querySelector('details summary')?.textContent).toContain('商品 21')
    expect(commands).toEqual([])
    const prompt = host.querySelector<HTMLTextAreaElement>('details textarea')!
    await vi.waitFor(() => expect(prompt.disabled).toBe(false))
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        prompt,
        '仅修改第 21 件',
      )
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('保存计划')!.click())
    await vi.waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]?.items).toHaveLength(100)
    expect(patches[0]?.items[0]?.prompt).toBe('商品 1 原样')
    expect(patches[0]?.items[20]?.prompt).toBe('仅修改第 21 件')
    expect(patches[0]?.items[99]?.prompt).toBe('商品 100 原样')
    await vi.waitFor(() => expect(button('确认生成')?.disabled).toBe(false))
    await act(async () => button('确认生成')!.click())
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({
      expectedVersion: 2,
      expectedDigest: 'b'.repeat(64),
      commandId: expect.any(String),
    })
    expect(host.textContent).toContain('累计提交 100 次')
    expect(host.querySelectorAll('details')).toHaveLength(20)
  } finally {
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})

it('keeps the review page and failed selections across polling, then quotes the complete cross-page retry selection', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  setClientStorageScope('batch-cross-page-owner')
  const quote = {
    status: 'available' as const,
    estimatedCredits: 100,
    estimatedChargeCredits: 100,
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
      version: 1,
      digest: 'r'.repeat(64),
      title: '跨页重试',
      rule: '只重试所选失败项',
      itemCount: 100,
      status: 'paused',
      executionEnabled: true,
      submittedCount: 100,
      actualCredits: 0,
      estimate: {
        analysis: { ...quote, estimatedCredits: 0, estimatedChargeCredits: 0 },
        generation: quote,
      },
      createdAt: 1,
    },
    items: Array.from({ length: 100 }, (_, ordinal) => ({
      key: `item-${ordinal}`,
      ordinal,
      kind: 'generation',
      prompt: `商品 ${ordinal + 1}`,
      inputs: [],
      dependencies: [],
      params: { provider: 'openai-compat', model: 'image-model' },
      progress: ordinal === 99 ? 'reconciling' : 'failed',
      execution: {
        taskId: `task-${ordinal}`,
        status: ordinal === 99 ? 'reconciling' : 'failed',
        attempt: 1,
        actualCredits: ordinal === 99 ? null : 0,
        errorCode: ordinal === 99 ? 'result_unknown' : 'content_policy',
      },
    })),
    nextCursor: null,
  }
  let reads = 0
  const quotes: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    if (init?.method === 'POST') {
      expect(url.endsWith('/retry-quote')).toBe(true)
      quotes.push(JSON.parse(String(init.body)))
      page = {
        ...page,
        batch: {
          ...page.batch,
          version: 2,
          digest: 'q'.repeat(64),
          confirmationRequired: true,
          retryItemKeys: ['item-0', 'item-20'],
          retryRequiresResume: true,
        },
      }
    } else reads++
    return Response.json(page)
  })
  const message = panelMessage('cross-page-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'cross-page-call',
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
  const check = (index: number) =>
    host.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="选择重试第 ${index} 项"]`)!
  try {
    vi.useFakeTimers()
    await act(async () => root.render(<AgentToolCard message={message} />))
    const failed = () => host.querySelector('[data-batch-status="failed"]')!
    await vi.waitFor(() => expect(failed().querySelector('button')).not.toBeNull())
    expect(failed().querySelector('details')).toBeNull()
    act(() => failed().querySelector('button')!.click())
    await vi.waitFor(() => expect(failed().querySelectorAll('details')).toHaveLength(20))
    await vi.waitFor(() => expect(check(1).disabled).toBe(false))
    act(() => {
      failed()
        .querySelector('details summary')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      check(1).click()
    })
    act(() => button('下一页')!.click())
    act(() => {
      failed()
        .querySelector('details summary')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      check(21).click()
    })
    expect(check(21).getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(reads).toBe(2)
    expect(host.textContent).toContain('2 / 5')
    expect(check(21).getAttribute('aria-checked')).toBe('true')
    act(() => button('上一页')!.click())
    expect(check(1).getAttribute('aria-checked')).toBe('true')
    vi.useRealTimers()
    await act(async () => button('获取重试报价')!.click())
    await vi.waitFor(() => expect(quotes).toHaveLength(1))
    expect(quotes[0]).toMatchObject({
      expectedVersion: 1,
      itemKeys: ['item-0', 'item-20'],
      commandId: expect.any(String),
    })
    expect(button('确认重试')?.disabled).toBe(false)
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
    host.remove()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})
