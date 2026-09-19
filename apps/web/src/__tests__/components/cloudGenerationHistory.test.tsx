// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CloudTaskTile from '../../components/CloudTaskTile'
import GenerationHistory from '../../components/GenerationHistory'
import InputBar from '../../components/InputBar'
import { setClientStorageScope } from '../../lib/authScope'
import { setChannels } from '../../lib/channels/channelStore'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { getImage, hashDataUrl, putImage } from '../../lib/db'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'

let host: HTMLDivElement
let root: Root

const MANIFEST = {
  'accounts:local-recovery': false,
  'accounts:login': true,
  'accounts:self-register': false,
  'accounts:sync': true,
  'agent:chat': false,
  'billing:credits': false,
  'generation:byok': true,
  'generation:video': false,
  'quota:daily': false,
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope('owner')
  setChannels([])
  // 作品页只有登录且开着同步的部署才读平台记录，能力位得先就位。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(MANIFEST)),
  )
  await bootstrapClientCapabilities(true, '')
  vi.unstubAllGlobals()
  // 作品页现在自带输入框，它一挂载就去 IDB 读模板，所以每个用例都要有 IDB。
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({
    prompt: '',
    params: { ...DEFAULT_PARAMS },
    inputImages: [],
    maskDraft: null,
    tasks: [],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
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
  archiveStatus: 'none',
  errorType: null,
  cover: null,
  createdAt: 1789600000000,
  startedAt: null,
  completedAt: null,
  revision: '1',
} as const
/** 详情浮层 portal 到 body，所以按钮在整篇文档里找，不只在挂载点里。 */
const button = (label: string) => {
  const found = [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label),
  )
  if (!found) throw new Error(`missing button: ${label}`)
  return found
}
const click = async (label: string) => {
  await act(async () => button(label).click())
}
/** 平台记录那张卡是整块可点的按钮；点它打开详情。 */
const openTile = async () => {
  const tile = host.querySelector<HTMLButtonElement>('button[aria-label*="gpt-image-2"]')
  if (!tile) throw new Error('missing cloud tile')
  await act(async () => tile.click())
}

it('作品页一条列表就展示平台记录，点开能看到提示词', async () => {
  // 空列表会渲出灵感库空态，它自己也发请求；所以这里按 URL 分派，不按调用顺序。
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/api/generations?limit=50')
      return Response.json({ items: [item], nextCursor: null })
    if (url.startsWith('/api/generations/'))
      return Response.json({
        ...item,
        prompt: '一只在阳光下睡觉的猫',
        parameters: {},
        actualParameters: {},
        inputs: [],
        mask: null,
        outputs: [],
      })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  expect(host.textContent).toContain('gpt-image-2')
  expect(host.textContent).toContain('排队中')
  // 没有「此设备 / 云端记录」这种页签：存储位置不是用户要挑的东西。
  expect(host.textContent).not.toContain('此设备')
  expect(host.textContent).not.toContain('云端记录')
  await openTile()
  expect(document.body.textContent).toContain('一只在阳光下睡觉的猫')
  const list = fetcher.mock.calls.find(([url]) => url === '/api/generations?limit=50')
  expect(list?.[1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
})

it('一条作品都没有时输入框顶在页面上方，有作品之后浮回底部', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/generations?limit=50'
        ? Response.json({ items: [], nextCursor: null })
        : Response.json({}),
    ),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  const placement = () =>
    host.querySelector('[data-input-bar]')?.getAttribute('data-input-bar-placement')
  // 空画廊：浮动输入框会压住灵感探索那一排，所以它让位到顶部。
  expect(placement()).toBe('hero')
  await act(async () => {
    useStore.setState({
      tasks: [
        {
          id: 'local-1',
          prompt: '一只猫',
          params: { ...DEFAULT_PARAMS },
          inputImageIds: [],
          outputImages: [],
          status: 'done',
          error: null,
          createdAt: 1789600000001,
          finishedAt: 1789600000002,
          elapsed: 1,
        },
      ],
    })
  })
  expect(placement()).toBe('docked')
})

it('加载更多把下一页续在同一条列表后面，不替换已读到的记录', async () => {
  const second = {
    ...item,
    id: '22222222-2222-4222-8222-222222222222',
    model: 'second-model',
    createdAt: item.createdAt - 1000,
  }
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/generations?limit=50')
      return Response.json({ items: [item], nextCursor: 'next-page' })
    if (url === '/api/generations?limit=50&cursor=next-page')
      return Response.json({ items: [second], nextCursor: null })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await click('加载更多')
  expect(host.textContent).toContain('second-model')
  expect(host.textContent).toContain('gpt-image-2')
  expect(fetcher.mock.calls.map(([url]) => url)).toContain(
    '/api/generations?limit=50&cursor=next-page',
  )
})

it('切换账号后丢弃上一账号晚到的历史响应', async () => {
  let respond!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    // 这个包的 lib 目标还没有 Promise.withResolvers，这里只能用 executor 形式挂住 resolve。
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    ),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
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
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('刷新重试')
  await click('刷新')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('gpt-image-2')
})

it('本机已有同一条生成时只显示本机那张卡，不重复一条平台记录', async () => {
  useStore.setState({
    tasks: [
      {
        id: 'local-1',
        prompt: '本机记录',
        status: 'completed',
        createdAt: item.createdAt,
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: [],
        bffRequestId: item.id,
      } as never,
    ],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [item], nextCursor: null })),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  expect(host.querySelector('button[aria-label*="gpt-image-2"]')).toBeNull()
})

it('列表展示封面时只读取预览，原件留到用户明确下载', async () => {
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
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://media.example/preview.webp')
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('https://media.example/original.png')
})

it('复用平台记录在当前作品输入框显示提示词与参数，不自动提交生成', async () => {
  useStore.setState({ appMode: 'browse' })
  function TileWithComposer() {
    const mode = useStore((state) => state.appMode)
    return mode === 'browse' ? (
      <>
        <CloudTaskTile item={item} />
        <InputBar />
      </>
    ) : (
      <div>画布</div>
    )
  }
  setChannels([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'Image',
      defaults: {},
      models: [{ id: 'gpt-image-2', label: 'GPT Image', capabilities: ['generate'] }],
    },
  ])
  const fetcher = vi.fn(async () =>
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
  await act(async () => root.render(<TileWithComposer />))
  await openTile()
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
  expect(host.querySelector('[contenteditable]')?.textContent).toBe('一只猫')
  expect(useStore.getState().appMode).toBe('browse')
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(fetcher).toHaveBeenCalledTimes(1)
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
  await act(async () => root.render(<CloudTaskTile item={item} />))
  await openTile()
  expect(urls).toContain('https://media.example/output-preview.webp')
  expect(urls).not.toContain('https://media.example/output-original.png')
  await act(async () => {
    button('下载原图').click()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  })
  expect(urls).toContain('https://media.example/output-original.png')
  expect((download.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toMatch(/\.png$/)
  download.mockRestore()
})

it('复用参考图下载期间切换账号，不覆盖新账号的创作内容', async () => {
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
  await act(async () => root.render(<CloudTaskTile item={item} />))
  await openTile()
  await act(async () => {
    button('复用参数').click()
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
  await act(async () => root.render(<CloudTaskTile item={item} />))
  await openTile()
  await act(async () => {
    button('复用参数').click()
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
