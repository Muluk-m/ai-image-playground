// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CloudGenerationHistory from '../../components/CloudGenerationHistory'
import { setClientStorageScope } from '../../lib/authScope'
import { setChannels } from '../../lib/channels/channelStore'
import { getImage, hashDataUrl, putImage } from '../../lib/db'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope('owner')
  setChannels([])
  useStore.setState({
    prompt: '',
    params: { ...DEFAULT_PARAMS },
    inputImages: [],
    maskDraft: null,
    tasks: [],
  })
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
    .mockResolvedValueOnce(
      Response.json({
        ...item,
        prompt: '一只在阳光下睡觉的猫',
        parameters: {},
        actualParameters: {},
        inputs: [],
        mask: null,
        outputs: [],
      }),
    )
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

it('云端列表展示封面时只读取预览，原件留到用户明确下载', async () => {
  const mediaId = '77777777-7777-4777-8777-777777777777'
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/api/generations'))
      return Response.json({
        items: [
          {
            ...item,
            status: 'completed',
            cover: { index: 0, mediaId, width: 8, height: 6, contentType: 'image/png' },
          },
        ],
        nextCursor: null,
      })
    if (url === `/api/media/${mediaId}/access`)
      return Response.json({
        previewUrl: 'https://media.example/preview.webp',
        originalUrl: 'https://media.example/original.png',
        expiresAt: Date.now() + 600000,
      })
    return new Response('image bytes')
  })
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<CloudGenerationHistory />))
  expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://media.example/preview.webp')
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('https://media.example/original.png')
})

it('复用云端记录恢复相同模型与参数，进入创作但不自动提交生成', async () => {
  setChannels([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'Image',
      defaults: {},
      models: [{ id: 'gpt-image-2', label: 'GPT Image', capabilities: ['generate'] }],
    },
  ])
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [item], nextCursor: null }))
    .mockResolvedValueOnce(
      Response.json({
        ...item,
        prompt: '一只猫',
        parameters: {
          size: '1536x1024',
          quality: 'high',
          n: 2,
          output_format: 'webp',
          output_compression: 90,
        },
        actualParameters: {},
        inputs: [],
        mask: null,
        outputs: [],
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<CloudGenerationHistory />))
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(label),
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await click('查看详情')
  await click('复用参数')
  expect(useStore.getState().prompt).toBe('一只猫')
  expect(useStore.getState().params).toMatchObject({
    size: '1536x1024',
    quality: 'high',
    n: 2,
    output_format: 'webp',
    output_compression: 90,
  })
  const settings = useStore.getState().settings
  expect(
    settings.profiles.find((profile) => profile.id === settings.activeProfileId),
  ).toMatchObject({ source: 'builtin-edge', selectedModelId: 'gpt-image-2' })
  expect(useStore.getState().appMode).toBe('create')
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('展开输出只加载预览，点击下载原图后才取原件并保留文件格式', async () => {
  const mediaId = '88888888-8888-4888-8888-888888888888'
  const urls: string[] = []
  const nativeFetch = globalThis.fetch
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:download'
      static revokeObjectURL = () => {}
    },
  )
  const fetcher = vi.fn(async (url: string) => {
    urls.push(url)
    if (url.startsWith('data:')) return nativeFetch(url)
    if (url.includes('/access'))
      return Response.json({
        previewUrl: 'https://media.example/output-preview.webp',
        originalUrl: 'https://media.example/output-original.png',
        expiresAt: Date.now() + 600000,
      })
    if (url.startsWith('https://media.example'))
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['exact original'], { type: 'image/png' }),
      } as Response
    if (url.includes('?')) return Response.json({ items: [item], nextCursor: null })
    return Response.json({
      ...item,
      prompt: '原图',
      parameters: {},
      actualParameters: {},
      inputs: [],
      mask: null,
      outputs: [{ index: 0, mediaId, width: 8, height: 6, contentType: 'image/png' }],
    })
  })
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<CloudGenerationHistory />))
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('查看详情'))!
      .click(),
  )
  expect(urls).toContain('https://media.example/output-preview.webp')
  expect(urls).not.toContain('https://media.example/output-original.png')
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('下载原图'),
  )
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  })
  expect(urls).toContain('https://media.example/output-original.png')
  expect((download.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toMatch(/\.png$/)
  download.mockRestore()
})

it('复用参考图下载期间切换账号，不覆盖新账号的创作内容', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'Image',
      defaults: {},
      models: [
        { id: 'gpt-image-2', label: 'GPT Image', capabilities: ['generate', 'edit', 'mask'] },
      ],
    },
  ])
  const mediaId = '99999999-9999-4999-8999-999999999999'
  let respond!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/access'))
        return Response.json({
          previewUrl: 'https://media.example/scope-preview',
          originalUrl: 'https://media.example/scope-original',
          expiresAt: Date.now() + 600000,
        })
      if (url === 'https://media.example/scope-original')
        return new Promise<Response>((resolve) => {
          respond = resolve
        })
      if (url === 'https://media.example/scope-preview')
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(['preview'], { type: 'image/png' }),
        } as Response
      if (url.includes('?')) return Response.json({ items: [item], nextCursor: null })
      return Response.json({
        ...item,
        prompt: '旧账号内容',
        parameters: {},
        actualParameters: {},
        inputs: [{ index: 0, mediaId, width: 8, height: 6, contentType: 'image/png' }],
        mask: null,
        outputs: [],
      })
    }),
  )
  await act(async () => root.render(<CloudGenerationHistory />))
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('查看详情'))!
      .click(),
  )
  await act(async () => {
    ;[...host.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('复用参数'))!
      .click()
    await vi.waitFor(() => expect(respond).toBeDefined())
  })
  setClientStorageScope('different-owner')
  useStore.setState({ prompt: '新账号草稿', inputImages: [] })
  await act(async () => {
    respond({
      ok: true,
      status: 200,
      blob: async () => new Blob(['original'], { type: 'image/png' }),
    } as Response)
  })
  expect(useStore.getState().prompt).toBe('新账号草稿')
  expect(useStore.getState().inputImages).toEqual([])
})

it('复用完整参考图和蒙版，不改写本机已有原图的来源和创建时间', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'Image',
      defaults: {},
      models: [
        { id: 'gpt-image-2', label: 'GPT Image', capabilities: ['generate', 'edit', 'mask'] },
      ],
    },
  ])
  const inputId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const maskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const dataUrl = `data:image/png;base64,${btoa('input-original')}`
  const storedId = await hashDataUrl(dataUrl)
  await putImage({
    id: storedId,
    dataUrl,
    source: 'generated',
    createdAt: 123,
    width: 8,
    height: 6,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/access')) {
        const kind = url.includes(inputId) ? 'input' : 'mask'
        return Response.json({
          previewUrl: `https://media.example/${kind}-preview`,
          originalUrl: `https://media.example/${kind}-original`,
          expiresAt: Date.now() + 600000,
        })
      }
      if (url.startsWith('https://media.example/'))
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([url.split('/').slice(-1)[0]!], { type: 'image/png' }),
        } as Response
      if (url.includes('?')) return Response.json({ items: [item], nextCursor: null })
      return Response.json({
        ...item,
        prompt: '带蒙版',
        parameters: {},
        actualParameters: {},
        inputs: [{ index: 0, mediaId: inputId, width: 8, height: 6, contentType: 'image/png' }],
        mask: { index: 0, mediaId: maskId, width: 8, height: 6, contentType: 'image/png' },
        outputs: [],
      })
    }),
  )
  await act(async () => root.render(<CloudGenerationHistory />))
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('查看详情'))!
      .click(),
  )
  await act(async () => {
    ;[...host.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('复用参数'))!
      .click()
    await vi.waitFor(() => expect(useStore.getState().prompt).toBe('带蒙版'))
  })
  expect(useStore.getState().inputImages).toEqual([{ id: storedId, dataUrl }])
  expect(useStore.getState().maskDraft).toMatchObject({
    targetImageId: storedId,
    maskDataUrl: `data:image/png;base64,${btoa('mask-original')}`,
  })
  expect(await getImage(storedId)).toMatchObject({
    source: 'generated',
    createdAt: 123,
    width: 8,
    height: 6,
  })
})
