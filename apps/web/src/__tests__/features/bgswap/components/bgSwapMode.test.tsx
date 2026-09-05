// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BgSwapMode from '../../../../features/bgswap/components/BgSwapMode'
import { useBgSwapStore } from '../../../../features/bgswap/store'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const isClientCapabilityEnabled = vi.hoisted(() => vi.fn(() => true))
const storeImageFromFile = vi.hoisted(() =>
  vi.fn(async (file: File) => ({ id: `image-${file.name}`, dataUrl: `data:,${file.name}` })),
)
const ensureImageCached = vi.hoisted(() => vi.fn())
const submitPrepared = vi.hoisted(() => vi.fn())
const requestBackgroundPlan = vi.hoisted(() => vi.fn())
const segmentProduct = vi.hoisted(() => vi.fn())
const assessMatte = vi.hoisted(() => vi.fn())
const alphaToInpaintMask = vi.hoisted(() => vi.fn())
const modelSupportsNativeMask = vi.hoisted(() => vi.fn())
const storeImage = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  storeImageFromFile,
  ensureImageCached,
  submitPrepared,
}))

vi.mock('../../../../features/bgswap/lib/planClient', () => ({ requestBackgroundPlan }))

vi.mock('../../../../lib/productMatte', () => ({ segmentProduct, assessMatte, alphaToInpaintMask }))

vi.mock('../../../../lib/channels/profileSelectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/channels/profileSelectors')>()),
  modelSupportsNativeMask,
}))

vi.mock('../../../../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/db')>()),
  storeImage,
}))

const PLAN = {
  category: '折叠浴缸',
  sceneType: '纯白背景',
  productBox: null,
  plan: '放进有窗光的日式木质浴室',
  prompt: '锁住产品，只换背景',
}

/** 一个能被外部推进的 promise，让测试停在某一段上观察读秒文案。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), tasks: [] })
  useBgSwapStore.setState({
    jobs: [],
    swapStage: null,
    swapStartedAt: null,
    loadJobs: vi.fn().mockResolvedValue(undefined),
  })
  useBgSwapStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  submitPrepared.mockResolvedValue(['task-1'])
  requestBackgroundPlan.mockResolvedValue(PLAN)
  segmentProduct.mockResolvedValue({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
  assessMatte.mockReturnValue({ ok: true, coverage: 0.4 })
  alphaToInpaintMask.mockReturnValue('data:image/png;base64,MASK')
  modelSupportsNativeMask.mockReturnValue(true)
  storeImage.mockResolvedValue('mask-1')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function render() {
  act(() => root.render(<BgSwapMode />))
}

/** 一次点击要串起接口、抠图与 IndexedDB 落盘，微任务刷一轮不够。 */
async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function column(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-bgswap-column="${name}"]`)
  if (!element) throw new Error(`no ${name} column`)
  return element
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function upload(label: string, ...files: File[]) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no file input labelled ${label}`)
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('the background swap workbench', () => {
  it('lays out the sources, the preview and the controls', () => {
    render()

    expect(column('sources').textContent).toContain('原图')
    expect(column('preview').textContent).toContain('当前版')
    expect(column('controls').textContent).toContain('换背景')
  })

  it('shows an uploaded image in the source list', async () => {
    render()

    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await act(async () => {})

    expect(column('sources').querySelectorAll('[data-bgswap-source]')).toHaveLength(1)
    expect(useBgSwapStore.getState().draft.images).toHaveLength(1)
  })

  it('drops an image from the source list', async () => {
    render()

    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await act(async () => {})
    const remove = document.querySelector('[aria-label="移除原图 1"]')
    if (!remove) throw new Error('no remove button')
    click(remove)

    expect(useBgSwapStore.getState().draft.images).toEqual([])
  })

  it('offers the link field only while link fetching is on', () => {
    render()
    expect(document.querySelector('#bgswap-listing-url')).not.toBeNull()

    isClientCapabilityEnabled.mockReturnValue(false)
    act(() => root.render(<BgSwapMode />))

    expect(document.querySelector('#bgswap-listing-url')).toBeNull()
  })

  it('holds the background swap button until there is an image to work on', () => {
    render()

    expect(swapButton().disabled).toBe(true)
  })
})

describe('running one background swap', () => {
  async function withOneImage() {
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    // 任务落盘要等 IndexedDB 走完；没有 id 的草稿点「换背景」会被 store 直接挡回。
    while (useBgSwapStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('counts through planning, matting and generating', async () => {
    const plan = deferred<typeof PLAN>()
    const matte = deferred<{ alpha: Uint8ClampedArray; width: number; height: number }>()
    const submit = deferred<string[]>()
    requestBackgroundPlan.mockReturnValue(plan.promise)
    segmentProduct.mockReturnValue(matte.promise)
    submitPrepared.mockReturnValue(submit.promise)
    await withOneImage()

    click(swapButton())
    await settle()
    expect(swapButton().textContent).toContain('方案中')
    expect(swapButton().disabled).toBe(true)

    plan.resolve(PLAN)
    await settle()
    expect(swapButton().textContent).toContain('抠图中')

    matte.resolve({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
    await settle()
    expect(swapButton().textContent).toContain('生成中')

    submit.resolve(['task-1'])
    await settle()
    expect(swapButton().textContent).toBe('换背景')
  })

  it('puts the new version on the bar with its plan label', async () => {
    await withOneImage()

    click(swapButton())
    await settle()

    const [row] = document.querySelectorAll('[data-bgswap-version]')
    expect(row.textContent).toContain('第 1 版')
    expect(row.textContent).toContain(PLAN.plan)
    expect(row.textContent).toContain('排队')
  })

  it('marks a prompt-only version when the matte fails', async () => {
    segmentProduct.mockRejectedValue(new Error('抠图超时'))
    await withOneImage()

    click(swapButton())
    await settle()

    expect(document.querySelector('[data-bgswap-version]')?.textContent).toContain('未抠图')
  })

  it('takes a finished version as the chosen one', async () => {
    await withOneImage()
    click(swapButton())
    await settle()
    act(() => {
      useStore.setState({
        tasks: [finishedTask('task-1')],
      })
    })

    const choose = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '用这版',
    )
    if (!choose) throw new Error('no choose button')
    click(choose)
    await settle()

    const [version] = useBgSwapStore.getState().draft.images[0].versions
    expect(useBgSwapStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(document.querySelector('[data-bgswap-version]')?.textContent).toContain('已选')
  })

  it('switches the middle preview between the original and a version', async () => {
    await withOneImage()
    click(swapButton())
    await settle()

    expect(column('preview').textContent).toContain('第 1 版')

    const original = [...column('preview').querySelectorAll('button')].find(
      (button) => button.textContent === '原图',
    )
    if (!original) throw new Error('no original button')
    click(original)

    expect(column('preview').textContent).toContain('原图 1')
    expect(useBgSwapStore.getState().previewVersionId).toBeNull()
  })
})

function swapButton(): HTMLButtonElement {
  const button = [...column('controls').querySelectorAll('button')].find((item) =>
    /换背景|方案中|抠图中|生成中/.test(item.textContent ?? ''),
  )
  if (!button) throw new Error('no swap button')
  return button
}

function finishedTask(id: string) {
  return {
    id,
    prompt: PLAN.prompt,
    params: useStore.getState().params,
    inputImageIds: ['image-主图.png'],
    outputImages: ['out-1'],
    status: 'done' as const,
    error: null,
    createdAt: 1_000,
    finishedAt: 4_000,
    elapsed: 3_000,
  }
}
