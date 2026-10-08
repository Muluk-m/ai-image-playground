// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage, AgentBatchUpdate } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

let host: HTMLDivElement
let root: Root
let saved: AgentBatchPage
const writes: AgentBatchUpdate[] = []
const cancellations: { expectedVersion: number }[] = []
globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  writes.length = 0
  cancellations.length = 0
  saved = {
    batch: {
      id: 'batch-1',
      conversationId: 'conversation-1',
      originTurnId: 'turn-1',
      experience: 'chat',
      projectId: null,
      targetSnapshot: { projectId: null, projectRevision: null },
      version: 1,
      digest: 'a'.repeat(64),
      title: '商品白底图',
      rule: '换白底，保留包装',
      itemCount: 100,
      status: 'draft',
      executionEnabled: false,
      createdAt: 1,
      estimate: {
        analysis: {
          status: 'available',
          estimatedCredits: 0,
          estimatedChargeCredits: 0,
          snapshots: [],
        },
        generation: {
          status: 'available',
          estimatedCredits: 700,
          estimatedChargeCredits: 700,
          snapshots: [],
        },
      },
    },
    items: Array.from({ length: 100 }, (_, ordinal) => ({
      key: `item-${ordinal}`,
      ordinal,
      kind: 'generation',
      inputs: [
        { imageId: `image-${ordinal}`, mediaId: `media-${ordinal}`, name: `商品 ${ordinal + 1}` },
      ],
      prompt: `第 ${ordinal + 1} 张换白底`,
      params: { model: 'image-model', provider: 'openai-compat', size: '1024x1024' },
      dependencies: [],
    })),
    nextCursor: null,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/api/agent/batches/batch-1')) throw new Error(`Unexpected request: ${url}`)
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as AgentBatchUpdate
        writes.push(body)
        if (body.expectedVersion !== saved.batch.version)
          return Response.json({ error: 'batch_version_conflict' }, { status: 409 })
        saved = {
          ...saved,
          batch: { ...saved.batch, version: 2, rule: body.rule, digest: 'b'.repeat(64) },
          items: body.items.map((item) => {
            if (item.kind !== 'generation')
              throw new Error('unexpected analysis update in generation fixture')
            return item
          }),
        }
      }
      if (init?.method === 'POST' && url.endsWith('/cancel')) {
        const body = JSON.parse(String(init.body)) as { expectedVersion: number }
        cancellations.push(body)
        if (body.expectedVersion !== saved.batch.version)
          return Response.json({ error: 'batch_version_conflict' }, { status: 409 })
        saved = { ...saved, batch: { ...saved.batch, status: 'cancelled' } }
      }
      return Response.json(saved)
    }),
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('groups a running batch by status and leaves the waiting pile collapsed', async () => {
  saved = {
    ...saved,
    batch: { ...saved.batch, status: 'running', submittedCount: 1, executionEnabled: true },
    items: saved.items.map((item, index) =>
      index === 0
        ? {
            ...item,
            progress: 'in_flight',
            execution: {
              taskId: 'task-0',
              status: 'in_progress',
              attempt: 1,
              actualCredits: null,
            },
          }
        : { ...item, progress: 'ready' },
    ),
  }
  await render()
  const group = (status: string) => host.querySelector(`[data-batch-group="${status}"]`)
  const rows = (status: string) => host.querySelectorAll(`details[data-batch-status="${status}"]`)
  expect(group('in_flight')?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  expect(rows('in_flight')).toHaveLength(1)
  expect(group('in_flight')?.textContent).toContain('执行中')
  expect(group('ready')?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  expect(group('ready')?.textContent).toContain('待派发')
  expect(group('ready')?.textContent).toContain('99')
  expect(rows('ready')).toHaveLength(0)
  expect(host.querySelector('[aria-label="任务状态"]')?.className).toBe('max-h-64 overflow-y-auto')
  expect(host.querySelectorAll('summary img')).toHaveLength(1)
  expect(host.querySelector('nav')).toBeNull()
  act(() => group('ready')?.querySelector<HTMLButtonElement>('button')?.click())
  expect(rows('ready')).toHaveLength(20)
  expect(host.textContent).toContain('1 / 5')
  expect(host.querySelectorAll('summary img')).toHaveLength(21)
})

it('keeps an expanded execution row mounted when that item finishes', async () => {
  vi.useFakeTimers()
  saved = {
    ...saved,
    batch: {
      ...saved.batch,
      itemCount: 2,
      status: 'running',
      submittedCount: 2,
      executionEnabled: true,
    },
    items: saved.items.slice(0, 2).map((item, index) => ({
      ...item,
      progress: index === 0 ? ('in_flight' as const) : ('ready' as const),
      execution:
        index === 0
          ? { taskId: 'task-0', status: 'in_progress' as const, attempt: 1, actualCredits: null }
          : undefined,
    })),
  }
  try {
    const message = panelMessage('message-1', 'turn-1', 'assistant', [
      {
        type: 'toolResult',
        toolName: 'planImageBatch',
        toolCallId: 'call-1',
        title: '商品白底图',
        status: 'succeeded',
        batchId: 'batch-1',
      },
    ])
    if (message.kind !== 'tool') throw new Error('expected tool message')
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() =>
      expect(host.querySelector('details[data-item-key="item-0"]')).not.toBeNull(),
    )
    const row = host.querySelector<HTMLDetailsElement>('details[data-item-key="item-0"]')!
    act(() => {
      row.open = true
      row.dispatchEvent(new Event('toggle', { bubbles: false }))
    })
    expect(row.open).toBe(true)
    saved = {
      ...saved,
      items: saved.items.map((item) =>
        item.key === 'item-0'
          ? {
              ...item,
              progress: 'completed',
              execution: {
                taskId: 'task-0',
                status: 'completed',
                attempt: 1,
                actualCredits: 1,
              },
            }
          : item,
      ),
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    const moved = host.querySelector<HTMLDetailsElement>('details[data-item-key="item-0"]')
    expect(moved).toBe(row)
    expect(moved?.open).toBe(true)
    expect(moved?.getAttribute('data-batch-status')).toBe('completed')
    expect(
      host.querySelector('[data-batch-group="completed"] button')?.getAttribute('aria-expanded'),
    ).toBe('true')
  } finally {
    vi.useRealTimers()
  }
})

it('leaves focus where the user moved it when an open row finishes', async () => {
  vi.useFakeTimers()
  saved = {
    ...saved,
    batch: {
      ...saved.batch,
      itemCount: 2,
      status: 'running',
      submittedCount: 2,
      executionEnabled: true,
    },
    items: saved.items.slice(0, 2).map((item, index) => ({
      ...item,
      progress: index === 0 ? ('in_flight' as const) : ('ready' as const),
      execution:
        index === 0
          ? { taskId: 'task-0', status: 'in_progress' as const, attempt: 1, actualCredits: null }
          : undefined,
    })),
  }
  try {
    await render()
    const row = host.querySelector<HTMLDetailsElement>('details[data-item-key="item-0"]')!
    const summary = row.querySelector<HTMLElement>('summary')!
    act(() => {
      row.open = true
      row.dispatchEvent(new Event('toggle', { bubbles: false }))
      summary.focus()
      summary.blur()
    })
    expect(row.contains(document.activeElement)).toBe(false)
    saved = {
      ...saved,
      items: saved.items.map((item) =>
        item.key === 'item-0'
          ? {
              ...item,
              progress: 'completed',
              execution: {
                taskId: 'task-0',
                status: 'completed',
                attempt: 1,
                actualCredits: 1,
              },
            }
          : item,
      ),
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    const moved = host.querySelector<HTMLDetailsElement>('details[data-item-key="item-0"]')
    expect(moved?.contains(document.activeElement)).toBe(false)
    expect(moved?.open).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps plan fields to the card scale so a long rule stays in its box', async () => {
  await render()
  const rule = [...host.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('统一规则'),
  )
  const field = rule?.querySelector('textarea')
  expect(field?.rows).toBe(3)
  expect(field?.className).toContain('max-h-24')
  expect(field?.className).toContain('text-xs')
  const title = [...host.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('计划名称'),
  )
  expect(title?.querySelector('input')?.className).toContain('h-8')
  const thumb = host.querySelector('summary img')
  expect(thumb?.className).toContain('h-5')
  expect(thumb?.className).toContain('w-5')
})

async function render() {
  const message = panelMessage('message-1', 'turn-1', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-1',
      title: '商品白底图',
      status: 'succeeded',
      batchId: 'batch-1',
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool message')
  await act(async () => root.render(<AgentToolCard message={message} />))
  await vi.waitFor(() => expect(host.querySelector('details')).not.toBeNull())
}

function change(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function expectScopeAcrossPages(first: number, last: number) {
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((one) => one.textContent === label)!
  const names: (string | null)[] = []
  const count = last - first + 1
  const pages = Math.ceil(count / 20)
  for (let page = 0; page < pages; page += 1) {
    expect(host.querySelectorAll('details')).toHaveLength(Math.min(20, count - page * 20))
    names.push(
      ...[...host.querySelectorAll('summary img')].map((image) => image.getAttribute('alt')),
    )
    expect(button('下一页').disabled).toBe(page === pages - 1)
    if (page < pages - 1) act(() => button('下一页').click())
  }
  expect(names).toEqual(Array.from({ length: count }, (_, index) => `商品 ${first + index}`))
  for (let page = pages - 1; page > 0; page -= 1) act(() => button('上一页').click())
  expect(button('上一页').disabled).toBe(true)
}

it('分页可查完整100项和费用，展开编辑后保存，刷新恢复服务端新版本', async () => {
  await render()
  expectScopeAcrossPages(1, 100)
  expect(host.querySelector('[aria-label="700 积分"]')).not.toBeNull()
  const second = host.querySelectorAll('details')[1]!
  act(() => second.querySelector('summary')!.click())
  expect(second.open).toBe(true)
  const prompt = second.querySelector('textarea')!
  expect(prompt.value).toBe('第 2 张换白底')
  await vi.waitFor(() => expect(prompt.disabled).toBe(false))
  change(prompt, '第二张改浅灰底，包装保持原色')
  const save = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === '保存计划',
  )!
  await act(async () => save.click())
  expect(writes).toHaveLength(1)
  expect(writes[0]?.expectedVersion).toBe(1)
  expect(writes[0]?.items).toHaveLength(100)
  expect(writes[0]?.items[1]?.prompt).toBe('第二张改浅灰底，包装保持原色')
  expect(host.textContent).toContain('版本 2')
  const confirm = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === '确认生成',
  )!
  expect(confirm.disabled).toBe(true)
  expect(host.textContent).toContain('暂未开放执行')
  act(() => root.unmount())
  root = createRoot(host)
  await render()
  expect(host.querySelectorAll('details')[1]!.querySelector('textarea')!.value).toBe(
    '第二张改浅灰底，包装保持原色',
  )
})

it('修改范围和参数遇到版本冲突时保留草稿，显式刷新后可取消最新计划', async () => {
  await render()
  const first = host.querySelector('details')!
  act(() => first.querySelector('summary')!.click())
  const remove = [...first.querySelectorAll('button')].find(
    (button) => button.textContent === '移除此项',
  )
  expect(remove).toBeDefined()
  await vi.waitFor(() => expect(remove!.disabled).toBe(false))
  act(() => remove!.click())
  expectScopeAcrossPages(2, 100)
  expect(host.querySelector('summary')!.textContent).toContain('商品 2')
  const remaining = host.querySelector('details')!
  act(() => remaining.querySelector('summary')!.click())
  const size = remaining.querySelector<HTMLInputElement>('input[aria-label="尺寸"]')!
  change(size, '1536x1024')
  change(remaining.querySelector('textarea')!, '保留这段本地修改')
  // Another tab saves a newer plan before this draft is submitted.
  saved = {
    ...saved,
    batch: { ...saved.batch, version: 2 },
    items: saved.items.map((item) => ({ ...item, prompt: '服务端新版本提示词' })),
  }
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((one) => one.textContent === label)!
  await act(async () => button('保存计划').click())
  expect(writes).toHaveLength(1)
  expect(writes[0]?.expectedVersion).toBe(1)
  expect(writes[0]?.items).toHaveLength(99)
  expect(writes[0]?.items[0]).toMatchObject({
    key: 'item-1',
    ordinal: 0,
    prompt: '保留这段本地修改',
    params: { size: '1536x1024' },
  })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('计划已有新版本')
  expectScopeAcrossPages(2, 100)
  expect(host.querySelector('details textarea')?.getAttribute('disabled')).toBeNull()
  expect(host.querySelector<HTMLTextAreaElement>('details textarea')!.value).toBe(
    '保留这段本地修改',
  )
  expect(host.querySelector<HTMLInputElement>('details input[aria-label="尺寸"]')!.value).toBe(
    '1536x1024',
  )
  await act(async () => button('载入最新版本').click())
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('版本 2')
  expectScopeAcrossPages(1, 100)
  expect(host.querySelector<HTMLTextAreaElement>('details textarea')!.value).toBe(
    '服务端新版本提示词',
  )
  await vi.waitFor(() => expect(button('取消计划').disabled).toBe(false))
  await act(async () => button('取消计划').click())
  expect(cancellations).toEqual([{ expectedVersion: 2 }])
  expect(host.textContent).toContain('已取消')
  expect(host.querySelector<HTMLTextAreaElement>('details textarea')!.disabled).toBe(true)
  act(() => root.unmount())
  root = createRoot(host)
  await render()
  expect(host.textContent).toContain('已取消')
  expect(button('保存计划')).toBeUndefined()
})

it('展开计划项可审查非默认 Gemini 比例及每项完整输出参数', async () => {
  saved = {
    ...saved,
    batch: { ...saved.batch, itemCount: 2 },
    items: [
      {
        ...saved.items[0]!,
        kind: 'generation',
        params: {
          model: 'gemini-image',
          provider: 'gemini',
          gemini_image_size: '4K',
          gemini_aspect_ratio: '21:9',
          gemini_thinking_level: 'high',
        },
      },
      {
        ...saved.items[1]!,
        kind: 'generation',
        params: {
          model: 'image-model',
          provider: 'openai-compat',
          size: '1536x1024',
          quality: 'high',
          output_format: 'jpeg',
          output_compression: 67,
        },
      },
    ],
  }
  await render()
  const [gemini, image] = [...host.querySelectorAll('details')]
  act(() => {
    gemini!.querySelector('summary')!.click()
    image!.querySelector('summary')!.click()
  })
  expect(gemini!.textContent).toContain('宽高比')
  expect(gemini!.textContent).toContain('21:9')
  expect(gemini!.textContent).toContain('思考强度')
  expect(gemini!.querySelector<HTMLInputElement>('input[aria-label="尺寸"]')!.value).toBe('4K')
  expect(image!.textContent).toContain('画质')
  expect(image!.textContent).toContain('输出格式')
  expect(image!.textContent).toContain('JPEG')
  expect(image!.textContent).toContain('压缩质量')
  expect(image!.textContent).toContain('67')
  expect(image!.querySelector<HTMLInputElement>('input[aria-label="尺寸"]')!.value).toBe(
    '1536x1024',
  )
  expect(host.textContent).not.toContain('gemini_aspect_ratio')
  expect(host.textContent).not.toContain('output_compression')
})

it('同名输入图按各自媒体身份显示不同缩略图，便于核对完整范围', async () => {
  const firstId = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  saved = {
    ...saved,
    batch: { ...saved.batch, itemCount: 2 },
    items: saved.items.slice(0, 2).map((item, index) => ({
      ...item,
      inputs: [
        {
          imageId: item.inputs[0]!.imageId,
          mediaId: index === 0 ? firstId : secondId,
          name: '同名商品',
        },
      ],
    })),
  }
  const fetched: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('/api/agent/batches/batch-1')) return Response.json(saved)
      const mediaId = [firstId, secondId].find((id) => url.endsWith(`/api/media/${id}/access`))
      if (mediaId)
        return Response.json({
          originalUrl: `https://media.test/${mediaId}/original`,
          previewUrl: `https://media.test/${mediaId}/preview`,
          expiresAt: Date.now() + 600000,
        })
      if (url === `https://media.test/${firstId}/preview`)
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/webp' },
        })
      if (url === `https://media.test/${secondId}/preview`)
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { 'content-type': 'image/webp' },
        })
      throw new Error(`Unexpected media request: ${url}`)
    }),
  )
  await render()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const thumbnails = [...host.querySelectorAll('summary img')]
  expect(thumbnails).toHaveLength(2)
  expect(thumbnails.map((image) => image.getAttribute('src'))).toEqual([
    'data:image/webp;base64,AQID',
    'data:image/webp;base64,BAUG',
  ])
  expect(thumbnails.map((image) => image.getAttribute('alt'))).toEqual(['同名商品', '同名商品'])
  expect(fetched).toContain(`http://bff.test/api/media/${firstId}/access`)
  expect(fetched).toContain(`http://bff.test/api/media/${secondId}/access`)
  expect(fetched.some((url) => url.endsWith('/original'))).toBe(false)
})
