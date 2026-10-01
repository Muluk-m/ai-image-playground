// @vitest-environment jsdom
import type { ProductionDocument, ProductionGenerationView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ProductionGenerations from '../../../features/production/components/ProductionGenerations'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/authClient', () => ({ authenticatedBffFetch: request }))
vi.mock('../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => request.mockReset())
const doc: ProductionDocument = {
  id: 'doc',
  conversationId: 'conversation',
  projectId: null,
  revision: 3,
  updatedAt: 1,
  content: { title: '雨夜', setting: '', outline: '', scenes: [] },
}
const candidate: ProductionGenerationView = {
  draftId: 'draft',
  messageId: 'message',
  draftRevision: 1,
  production: {
    documentId: 'doc',
    revision: 2,
    target: 'clip',
    targetId: 'clip',
    snapshot: { name: '重逢', description: '在雨中奔跑', references: [] },
  },
  model: 'grok-imagine-video',
  prompt: '两人在雨中重逢',
  video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
  references: [],
  status: 'completed',
  taskId: 'task',
  artifacts: [
    { artifactId: 'artifact', media: 'video', taskId: 'task', outputIndex: 0, mime: 'video/mp4' },
  ],
}
it('restores target candidates, plays the original artifact and adopts only the selected result', async () => {
  const other = {
    ...candidate,
    draftId: 'other',
    production: { ...candidate.production, targetId: 'other' },
  }
  request.mockImplementation(
    async (url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith('/adopt')
            ? { document: { ...doc, revision: 4 } }
            : { generations: [other, candidate] },
        ),
      ),
  )
  const onSaved = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerations
          conversationId="conversation"
          document={doc}
          target={{ kind: 'clip', id: 'clip' }}
          onSaved={onSaved}
        />,
      ),
    )
    expect(host.querySelectorAll('video')).toHaveLength(1)
    expect(host.querySelector('video')?.getAttribute('src')).toContain('/task/')
    expect(host.textContent).toContain('两人在雨中重逢')
    expect(host.textContent).toContain('5s')
    const adopt = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === '采用此结果',
    )!
    await act(async () => adopt.click())
    const call = request.mock.calls.find(([url]) => url.endsWith('/adopt'))!
    expect(JSON.parse(call[1].body)).toMatchObject({ baseRevision: 3, artifactId: 'artifact' })
    expect(onSaved).toHaveBeenCalledWith({
      document: expect.objectContaining({ revision: 4 }),
      history: [],
    })
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('saves final draft edits before confirming its exact revision and recovers the receipt without a second confirmation', async () => {
  let current: ProductionGenerationView = {
    ...candidate,
    status: 'awaiting_confirmation',
    taskId: undefined,
    artifacts: [],
  }
  let confirms = 0
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      current = { ...current, ...body, draftRevision: 2 }
      return new Response(JSON.stringify({ generation: current }))
    }
    if (url.endsWith('/confirmations')) {
      confirms++
      current = { ...current, status: 'queued', taskId: 'accepted' }
      throw new TypeError('lost receipt')
    }
    return new Response(JSON.stringify({ generations: [current] }))
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerations
          conversationId="conversation"
          document={doc}
          target={{ kind: 'clip', id: 'clip' }}
          onSaved={() => {}}
        />,
      ),
    )
    const input = host.querySelector('textarea')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '镜头缓慢推进到两人的脸',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '确认生成')!
        .click(),
    )
    const confirm = request.mock.calls.find(([url]) => url.endsWith('/confirmations'))!
    expect(JSON.parse(confirm[1].body)).toMatchObject({
      messageId: 'message',
      prompt: '镜头缓慢推进到两人的脸',
      draftRevision: 2,
    })
    expect(confirms).toBe(1)
    expect(host.textContent).toContain('排队中')
    expect(
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '确认生成'),
    ).toBeUndefined()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('creates a separate pending candidate from the reviewed clip snapshot without submitting a task', async () => {
  let created: ProductionGenerationView | undefined
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      created = {
        ...candidate,
        ...body,
        status: 'awaiting_confirmation',
        draftId: 'new',
        taskId: undefined,
        artifacts: [],
      }
      return new Response(JSON.stringify({ generation: created }))
    }
    return new Response(
      JSON.stringify({ generations: created ? [candidate, created] : [candidate] }),
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerations
          conversationId="conversation"
          document={doc}
          target={{ kind: 'clip', id: 'clip' }}
          initialDraft={{
            prompt: '新的平移镜头',
            model: 'grok-imagine-video',
            video: candidate.video,
            references: [],
          }}
          onSaved={() => {}}
        />,
      ),
    )
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '新候选')!
        .click(),
    )
    expect(host.querySelector('textarea')?.value).toBe('新的平移镜头')
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '创建待确认草稿')!
        .click(),
    )
    const post = request.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(post[1].body)).toMatchObject({
      baseRevision: 3,
      target: 'clip',
      targetId: 'clip',
      prompt: '新的平移镜头',
      video: { duration_seconds: 5 },
    })
    expect(request.mock.calls.some(([url]) => url.endsWith('/confirmations'))).toBe(false)
    expect(host.querySelectorAll('video')).toHaveLength(1)
    expect(host.textContent).toContain('等待确认')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('retries one failed candidate once, restores its independent retry and cancels only that task', async () => {
  let retried = false,
    cancelled = false
  const failed = { ...candidate, status: 'failed', artifacts: [] }
  request.mockImplementation(async (url: string) => {
    if (url.endsWith('/retries')) {
      retried = true
      return new Response(JSON.stringify({ message: {} }))
    }
    if (url.endsWith('/cancel')) {
      cancelled = true
      return new Response(JSON.stringify({ job: {} }))
    }
    const retry = {
      ...candidate,
      messageId: 'retry-message',
      taskId: 'retry-task',
      status: cancelled ? 'cancelled' : 'queued',
      artifacts: [],
    }
    return new Response(JSON.stringify({ generations: retried ? [failed, retry] : [failed] }))
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ProductionGenerations
          conversationId="conversation"
          document={doc}
          target={{ kind: 'clip', id: 'clip' }}
          onSaved={() => {}}
        />,
      ),
    )
    const retry = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === '重试此候选',
    )!
    expect(retry).not.toBeUndefined()
    await act(async () => {
      retry.click()
      retry.click()
    })
    expect(request.mock.calls.filter(([url]) => url.endsWith('/retries'))).toHaveLength(1)
    expect(
      JSON.parse(request.mock.calls.find(([url]) => url.endsWith('/retries'))![1].body),
    ).toMatchObject({ messageId: 'message' })
    expect(host.querySelectorAll('.production-generation')).toHaveLength(2)
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '取消此任务')!
        .click(),
    )
    expect(request.mock.calls.some(([url]) => url.endsWith('/jobs/retry-task/cancel'))).toBe(true)
    expect(host.textContent).toContain('已取消')
    expect(host.textContent).toContain('失败')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
