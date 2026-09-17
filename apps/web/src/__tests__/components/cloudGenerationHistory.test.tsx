// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CloudGenerationHistory from '../../components/CloudGenerationHistory'
import { setClientStorageScope } from '../../lib/authScope'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope('owner')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})
const item = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'queued',
  createdAt: 1789600000000,
  startedAt: null,
  completedAt: null,
  revision: '1',
}
it('空白设备能查看云端任务及提示词，刷新显示最新状态', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [item], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ ...item, prompt: '一只在阳光下睡觉的猫' }))
    .mockResolvedValueOnce(
      Response.json({ items: [{ ...item, status: 'completed', revision: '3' }], nextCursor: null }),
    )
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<CloudGenerationHistory />))
  expect(host.textContent).toContain('gpt-image-2')
  expect(host.textContent).toContain('排队中')
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(label),
    )
    if (!found) throw new Error(`missing button: ${label}`)
    return found
  }
  await act(async () => button('查看详情').click())
  expect(host.textContent).toContain('一只在阳光下睡觉的猫')
  await act(async () => button('刷新').click())
  expect(host.textContent).toContain('已完成')
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/generations?limit=50')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
})
it('按页加载记录，翻页后不会继续堆积旧页节点', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [item], nextCursor: 'next-page' }))
    .mockResolvedValueOnce(
      Response.json({
        items: [{ ...item, id: '22222222-2222-4222-8222-222222222222', model: 'second-model' }],
        nextCursor: null,
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<CloudGenerationHistory />))
  const next = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('下一页'),
  )
  expect(next).toBeDefined()
  await act(async () => next!.click())
  expect(host.textContent).toContain('second-model')
  expect(host.textContent).not.toContain('gpt-image-2')
  expect(fetcher.mock.calls[1]?.[0]).toBe('/api/generations?limit=50&cursor=next-page')
})
it('切换账号后丢弃上一账号晚到的历史响应', async () => {
  let respond!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    ),
  )
  await act(async () => root.render(<CloudGenerationHistory />))
  setClientStorageScope('different-owner')
  await act(async () => respond(Response.json({ items: [item], nextCursor: null })))
  expect(host.textContent).not.toContain('gpt-image-2')
})
it('断网显示可恢复错误，刷新后能看到记录', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(Response.json({ items: [item], nextCursor: null })),
  )
  await act(async () => root.render(<CloudGenerationHistory />))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('刷新重试')
  const refresh = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('刷新'),
  )!
  await act(async () => refresh.click())
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('gpt-image-2')
})
