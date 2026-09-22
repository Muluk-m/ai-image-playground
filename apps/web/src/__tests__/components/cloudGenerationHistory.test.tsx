// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GenerationHistory from '../../components/GenerationHistory'
import InputBar from '../../components/InputBar'
import { setClientStorageScope } from '../../lib/authScope'
import { setChannels } from '../../lib/channels/channelStore'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
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
  // 平台记录会被镜像成本机任务记录写进 IndexedDB，作品页的输入框也要读模板。
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
    appMode: 'image',
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  // 上一条用例还在飞的镜像写入必须先落地，否则它会在下一条用例里凭空多出一张卡。
  await settle()
  act(() => root.unmount())
  host.remove()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  archiveStatus: 'none',
  errorType: null,
  cover: null,
  createdAt: 1789600000000,
  startedAt: 1789600000000,
  completedAt: 1789600001000,
  revision: '1',
  prompt: '一只在阳光下睡觉的猫',
  parameters: { size: '1536x1024', quality: 'high', n: 2, output_format: 'webp' },
  actualParameters: {},
} as const

const page = (items: unknown[], nextCursor: string | null = null) =>
  Response.json({ items, nextCursor })

/** 浮层 portal 到 body，所以按钮在整篇文档里找，不只在挂载点里。 */
const button = (label: string) => {
  const found = [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent?.includes(label) || node.title.includes(label),
  )
  if (!found) throw new Error(`missing button: ${label}`)
  return found
}
const click = async (label: string) => {
  await act(async () => button(label).click())
}
const cards = () => [...host.querySelectorAll('.task-card-wrapper')]

/** 平台记录要先写进 IndexedDB 才会出现在列表里，IDB 事务落在 act 之后若干拍。 */
const settle = async (ticks = 3) => {
  for (let i = 0; i < ticks; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}
/** 删除走确认框：点删除只是开框，真正的删除是框里那个动作。 */
const confirmDelete = async () => {
  await click('删除记录')
  const dialog = useStore.getState().confirmDialog
  if (!dialog) throw new Error('missing confirm dialog')
  await act(async () => {
    dialog.action?.()
  })
  await settle()
}
const waitCards = async (count: number) => {
  await act(async () => {
    await vi.waitFor(() => {
      if (cards().length !== count) throw new Error(`cards=${cards().length}`)
    })
  })
}

it('平台记录和本机生成用同一张卡：提示词、参数和动作都在上面', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.startsWith('/api/generations') ? page([item]) : Response.json({}),
  )
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await waitCards(1)
  // 卡上直接有提示词和模型，不是「模型名 + 时间 + 状态」的另一种穷卡。
  expect(host.textContent).toContain('一只在阳光下睡觉的猫')
  // 参数也在卡上，说明列表接口带回来的 parameters 真的用上了。
  expect(host.textContent).toContain('1536x1024')
  expect(button('复用配置')).toBeTruthy()
  expect(button('删除记录')).toBeTruthy()
  // 没有「此设备 / 云端记录」这种页签：存储位置不是用户要挑的东西。
  expect(host.textContent).not.toContain('此设备')
  expect(host.textContent).not.toContain('云端记录')
  const list = fetcher.mock.calls.find(([url]) => url === '/api/generations?limit=50')
  expect(list?.[1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
})

it('加载更多把下一页续在同一条列表后面，不替换已读到的记录', async () => {
  const second = {
    ...item,
    id: '22222222-2222-4222-8222-222222222222',
    model: 'second-model',
    prompt: '第二页的记录',
    createdAt: item.createdAt - 1000,
  }
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/generations?limit=50') return page([item], 'next-page')
    if (url === '/api/generations?limit=50&cursor=next-page') return page([second])
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await settle()
  await click('加载更多')
  await waitCards(2)
  expect(host.textContent).toContain('第二页的记录')
  expect(host.textContent).toContain('一只在阳光下睡觉的猫')
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
  await settle()
  setClientStorageScope('different-owner')
  await act(async () => respond(page([item])))
  await settle()
  expect(cards()).toHaveLength(0)
})

it('断网显示可恢复错误，刷新后能看到记录', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(page([item])),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await settle()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('刷新重试')
  await click('刷新')
  await waitCards(1)
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('一只在阳光下睡觉的猫')
})

it('本机已有同一条生成时不再镜像出第二张卡', async () => {
  useStore.setState({
    tasks: [
      {
        id: 'local-1',
        prompt: '本机记录',
        status: 'done',
        createdAt: item.createdAt,
        finishedAt: item.createdAt,
        elapsed: 1,
        error: null,
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: [],
        bffRequestId: item.id,
      },
    ],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => page([item])),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await settle()
  expect(cards()).toHaveLength(1)
  expect(host.textContent).toContain('本机记录')
  expect(host.textContent).not.toContain('一只在阳光下睡觉的猫')
})

it('列表展示封面时只读取预览，原件留到用户明确下载', async () => {
  const mediaId = '77777777-7777-4777-8777-777777777777'
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/api/generations'))
      return page([
        { ...item, cover: { index: 0, mediaId, width: 8, height: 6, contentType: 'image/png' } },
      ])
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
  await settle()
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://media.example/preview.webp'),
  )
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('https://media.example/original.png')
})

it('复用平台记录把提示词与参数放进作品输入框，不自动提交生成', async () => {
  setChannels([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'Image',
      defaults: {},
      models: [{ id: 'gpt-image-2', label: 'GPT Image', capabilities: ['generate'] }],
    },
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/generations?limit=50'
        ? page([item])
        : Response.json({ ...item, inputs: [], mask: null, outputs: [] }),
    ),
  )
  await act(async () => {
    root.render(
      <>
        <GenerationHistory userId="owner" />
        <InputBar />
      </>,
    )
  })
  await waitCards(1)
  await click('复用配置')
  await settle()
  expect(useStore.getState().prompt).toBe('一只在阳光下睡觉的猫')
  expect(useStore.getState().params).toMatchObject({
    size: '1536x1024',
    quality: 'high',
    n: 2,
    output_format: 'webp',
  })
  const settings = useStore.getState().settings
  expect(
    settings.profiles.find((profile) => profile.id === settings.activeProfileId),
  ).toMatchObject({ source: 'builtin-edge', selectedModelId: 'gpt-image-2' })
  expect(host.querySelector('[contenteditable]')?.textContent).toBe('一只在阳光下睡觉的猫')
  expect(useStore.getState().appMode).toBe('image')
})

it('删除平台记录要删到平台；平台没删掉时卡还在', async () => {
  const calls: Array<{ url: string; method?: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method })
      if (init?.method === 'DELETE') return new Response(null, { status: 500 })
      return url.startsWith('/api/generations?') ? page([item]) : Response.json({})
    }),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await waitCards(1)
  await confirmDelete()
  expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith(item.id))).toBe(true)
  // 平台还留着这条记录，本机把卡抹掉只会在刷新后自己长回来，所以必须保持原样。
  expect(cards()).toHaveLength(1)
})

it('平台记录删成功后卡片消失', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return url.startsWith('/api/generations?') ? page([item]) : Response.json({})
    }),
  )
  await act(async () => root.render(<GenerationHistory userId="owner" />))
  await waitCards(1)
  await confirmDelete()
  await waitCards(0)
})
