// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import ProductShotsMode from '../../../../features/productShots/components/ProductShotsMode'
import { useProductShotsStore } from '../../../../features/productShots/store'
import { ProductMatteError } from '../../../../lib/productMatte'
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
const requestSceneScan = vi.hoisted(() => vi.fn())
const segmentProduct = vi.hoisted(() => vi.fn())
const assessMatte = vi.hoisted(() => vi.fn())
const alphaToInpaintMask = vi.hoisted(() => vi.fn())
const alphaToProductMask = vi.hoisted(() => vi.fn())
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

vi.mock('../../../../features/productShots/lib/planClient', () => ({
  requestBackgroundPlan,
  requestSceneScan,
}))

vi.mock('../../../../lib/productMatte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/productMatte')>()),
  segmentProduct,
  assessMatte,
  alphaToInpaintMask,
  alphaToProductMask,
}))

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
  camera: '略高的 3/4 侧视',
  sceneType: 'photo',
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
  useProductShotsStore.setState({
    jobs: [],
    swapStage: null,
    swapStartedAt: null,
    loadJobs: vi.fn().mockResolvedValue(undefined),
  })
  useProductShotsStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  submitPrepared.mockResolvedValue(['task-1'])
  requestBackgroundPlan.mockResolvedValue(PLAN)
  requestSceneScan.mockResolvedValue('photo')
  segmentProduct.mockResolvedValue({
    alpha: new Uint8ClampedArray(4),
    width: 2,
    height: 2,
    backend: 'wasm-u2netp',
    elapsedMs: 3200,
  })
  assessMatte.mockReturnValue({ ok: true, coverage: 0.4 })
  alphaToInpaintMask.mockReturnValue('data:image/png;base64,MASK')
  alphaToProductMask.mockReturnValue('data:image/png;base64,PRODUCT-MASK')
  useLibraryStore.setState({ assets: [], loadAssets: vi.fn().mockResolvedValue(undefined) })
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
  act(() => root.render(<ProductShotsMode />))
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
  const element = document.querySelector<HTMLElement>(`[data-product-shots-column="${name}"]`)
  if (!element) throw new Error(`no ${name} column`)
  return element
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no input labelled ${label}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
    expect(column('actions').textContent).toContain('换背景')
  })

  it('shows an uploaded image in the source list', async () => {
    render()

    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await act(async () => {})

    expect(column('sources').querySelectorAll('[data-product-shots-source]')).toHaveLength(1)
    expect(useProductShotsStore.getState().draft.images).toHaveLength(1)
  })

  it('drops an image from the source list', async () => {
    render()

    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await act(async () => {})
    const remove = document.querySelector('[aria-label="移除原图 1"]')
    if (!remove) throw new Error('no remove button')
    click(remove)

    expect(useProductShotsStore.getState().draft.images).toEqual([])
  })

  it('holds the background swap button until there is an image to work on', () => {
    render()

    expect(actionButton().disabled).toBe(true)
  })
})

describe('picking where the source images come from', () => {
  function sourceTab(label: string): HTMLButtonElement {
    const button = [...column('sources').querySelectorAll('button')].find(
      (item) => item.textContent === label,
    )
    if (!button) throw new Error(`no ${label} tab`)
    return button
  }

  it('offers uploading, the listing link and the asset library', () => {
    render()

    expect(sourceTab('上传').getAttribute('aria-pressed')).toBe('true')
    expect(sourceTab('亚马逊链接')).toBeTruthy()
    expect(sourceTab('素材库')).toBeTruthy()
  })

  it('shows the link field only on the link tab, and only while fetching is on', () => {
    render()
    expect(document.querySelector('#product-shots-listing-url')).toBeNull()

    click(sourceTab('亚马逊链接'))
    expect(document.querySelector('#product-shots-listing-url')).not.toBeNull()

    isClientCapabilityEnabled.mockReturnValue(false)
    act(() => root.render(<ProductShotsMode />))

    expect(document.querySelector('#product-shots-listing-url')).toBeNull()
    expect(
      [...column('sources').querySelectorAll('button')].some(
        (item) => item.textContent === '亚马逊链接',
      ),
    ).toBe(false)
  })

  it('takes an asset out of the library as a source image', async () => {
    useLibraryStore.setState({
      assets: [{ id: 'a1', name: '主图白底', imageId: 'asset-1', createdAt: 1, lastUsedAt: 1 }],
    })
    render()

    click(sourceTab('素材库'))
    const open = [...column('sources').querySelectorAll('button')].find(
      (item) => item.textContent === '从素材库选',
    )
    if (!open) throw new Error('no library picker button')
    click(open)
    await settle()

    const picker = document.querySelector('[data-product-shots-source-picker]')
    if (!picker) throw new Error('no source picker overlay')
    const card = [...picker.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('主图白底'),
    )
    if (!card) throw new Error('no asset card')
    click(card)
    const add = [...picker.querySelectorAll('button')].find(
      (item) => item.textContent === '加入 1 张',
    )
    if (!add) throw new Error('no add button')
    click(add)
    await settle()

    expect(document.querySelector('[data-product-shots-source-picker]')).toBeNull()
    expect(useProductShotsStore.getState().draft.images.map((image) => image.imageId)).toContain(
      'asset-1',
    )
  })
})

describe('running one background swap', () => {
  async function withOneImage() {
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    // 任务落盘要等 IndexedDB 走完；没有 id 的草稿点「换背景」会被 store 直接挡回。
    while (useProductShotsStore.getState().draft.id === null) {
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

    click(actionButton())
    await settle()
    expect(actionButton().textContent).toContain('方案中')
    expect(actionButton().disabled).toBe(true)

    plan.resolve(PLAN)
    await settle()
    expect(actionButton().textContent).toContain('抠图中')

    matte.resolve({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
    await settle()
    expect(actionButton().textContent).toContain('生成中')

    submit.resolve(['task-1'])
    await settle()
    expect(actionButton().textContent).toBe('换背景')
  })

  it('puts the new version on the bar with its plan label', async () => {
    await withOneImage()

    click(actionButton())
    await settle()

    const [row] = document.querySelectorAll('[data-product-shots-version]')
    expect(row.textContent).toContain('第 1 版')
    expect(row.textContent).toContain(PLAN.plan)
    expect(row.textContent).toContain('排队')
  })

  it('marks a prompt-only version with why the matte was skipped', async () => {
    segmentProduct.mockRejectedValue(new ProductMatteError('timeout', '抠图超时'))
    await withOneImage()

    click(actionButton())
    await settle()

    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain(
      '未抠图 · 超时',
    )
  })

  it('shows which backend produced the matte', async () => {
    await withOneImage()

    click(actionButton())
    await settle()

    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain(
      'U²-Netp · CPU',
    )
  })

  it('takes a finished version as the chosen one', async () => {
    await withOneImage()
    click(actionButton())
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

    const [version] = useProductShotsStore.getState().draft.images[0].versions
    expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain('已选')
  })

  it('switches the middle preview between the original and a version', async () => {
    await withOneImage()
    click(actionButton())
    await settle()

    expect(column('preview').textContent).toContain('第 1 版')

    const original = [...column('preview').querySelectorAll('button')].find(
      (button) => button.textContent === '原图',
    )
    if (!original) throw new Error('no original button')
    click(original)

    expect(column('preview').textContent).toContain('原图 1')
    expect(useProductShotsStore.getState().previewVersionId).toBeNull()
  })
})

describe('marking the images that carry explanatory text', () => {
  it('labels a diagram in the source list and counts it out of the batch', async () => {
    requestSceneScan.mockResolvedValue('infographic')
    render()

    upload(
      '上传原图',
      new File(['x'], '主图.png', { type: 'image/png' }),
      new File(['x'], '示意图.png', { type: 'image/png' }),
    )
    await settle()

    const [, diagram] = column('sources').querySelectorAll('[data-product-shots-source]')
    expect(diagram.textContent).toContain('含说明文字，换背景会丢失')
    expect(batchBar().textContent).toContain('已跳过 1 张示意图')
    expect(batchBar().textContent).toContain('对剩下的 0 张')
  })
})

describe('looking at the matte before trusting a version', () => {
  it('switches the middle preview to the matte laid over the original', async () => {
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    while (useProductShotsStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    click(actionButton())
    await settle()

    const toggle = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '看蒙版',
    )
    if (!toggle) throw new Error('no matte toggle')
    click(toggle)

    expect(column('preview').textContent).toContain('原图 1 蒙版')

    click(toggle)

    expect(useProductShotsStore.getState().matteOverlayVersionId).toBeNull()
    expect(column('preview').textContent).toContain('第 1 版')
  })
})

describe('running the batch over the remaining images', () => {
  async function withTwoImages() {
    render()
    upload(
      '上传原图',
      new File(['x'], '主图.png', { type: 'image/png' }),
      new File(['x'], '细节.png', { type: 'image/png' }),
    )
    while (useProductShotsStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('offers the images the sample leaves behind', async () => {
    await withTwoImages()

    expect(batchBar().textContent).toContain('对剩下的 1 张')
    expect(batchButton().disabled).toBe(false)
  })

  it('counts the images through and lands them on done', async () => {
    await withTwoImages()

    click(batchButton())
    await settle()

    expect(useProductShotsStore.getState().draft.images[1].versions).toHaveLength(1)
    const [item] = batchBar().querySelectorAll('[data-product-shots-batch-item]')
    expect(item.textContent).toContain('原图 2')
    expect(item.textContent).toContain('完成')
  })

  it('reads the seconds out and offers a stop while it runs', async () => {
    const plan = deferred<typeof PLAN>()
    requestBackgroundPlan.mockReturnValue(plan.promise)
    await withTwoImages()

    click(batchButton())
    await settle()

    expect(batchBar().textContent).toContain('批量 0/1 · 原图 2')
    expect(batchBar().textContent).toContain('方案中')
    expect(actionButton().disabled).toBe(true)
    const stop = [...batchBar().querySelectorAll('button')].find(
      (button) => button.textContent === '停止',
    )
    if (!stop) throw new Error('no stop button')
    click(stop)
    plan.resolve(PLAN)
    await settle()
  })

  it('shows the failure reason and offers a rerun for that image', async () => {
    requestBackgroundPlan.mockRejectedValueOnce(new Error('没拿到可用的背景方案'))
    await withTwoImages()

    click(batchButton())
    await settle()

    const [item] = batchBar().querySelectorAll('[data-product-shots-batch-item]')
    expect(item.textContent).toContain('没拿到可用的背景方案')
    const rerun = [...item.querySelectorAll('button')].find(
      (button) => button.textContent === '重跑这张',
    )
    if (!rerun) throw new Error('no rerun button')
    click(rerun)
    await settle()

    expect(batchBar().querySelector('[data-product-shots-batch-item]')?.textContent).toContain(
      '完成',
    )
  })
})

describe('the product picked once for the whole job', () => {
  function productBar(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-product-shots-product]')
    if (!element) throw new Error('no product bar')
    return element
  }

  function describeButton(): HTMLButtonElement {
    const button = productBar().querySelector<HTMLButtonElement>('[data-product-shots-describe]')
    if (!button) throw new Error('no describe button')
    return button
  }

  function colorInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="禁止色"]')
    if (!input) throw new Error('no forbidden colours input')
    return input
  }

  function levelButton(label: string): HTMLButtonElement {
    const group = document.querySelector('[role="group"][aria-label="与竞品的距离"]')
    const button = [...(group?.querySelectorAll('button') ?? [])].find(
      (item) => item.textContent === label,
    )
    if (!button) throw new Error(`no ${label} level button`)
    return button
  }

  function pickerButton(): HTMLButtonElement {
    const button = [...productBar().querySelectorAll('button')].find((item) =>
      item.textContent?.includes('素材'),
    )
    if (!button) throw new Error('no picker button')
    return button
  }

  it('holds the product swap back until a product asset is picked', () => {
    render()

    expect(actionButton('replace-product').disabled).toBe(true)
    expect(column('actions').textContent).toContain('先在上方选产品素材')
  })

  it('holds the creative remix back until a product asset is picked', () => {
    render()

    expect(actionButton('remix').disabled).toBe(true)
    expect(column('actions').textContent).toContain('先在上方选产品素材')
  })

  it('picks how far the remix goes from the competitor', () => {
    render()

    expect(levelButton('不像').getAttribute('aria-pressed')).toBe('true')

    click(levelButton('像'))

    expect(useProductShotsStore.getState().draft.level).toBe('low')
    expect(levelButton('像').getAttribute('aria-pressed')).toBe('true')
  })

  it('describes the product once the panel is unfolded', () => {
    render()

    expect(productBar().querySelector('[aria-label="主色"]')).toBeNull()
    click(describeButton())

    type('主色', '哑光灰棕')

    expect(useProductShotsStore.getState().draft.product.mainColor).toBe('哑光灰棕')
  })

  it('says the colour may drift while nobody named the main colour', () => {
    render()
    click(describeButton())

    expect(productBar().textContent).toContain('未填主色，颜色可能漂')

    type('主色', '哑光灰棕')

    expect(productBar().textContent).not.toContain('未填主色，颜色可能漂')
  })

  it('keeps the forbidden colours as a list without eating the separator', () => {
    render()
    click(describeButton())

    type('禁止色', '米白、')

    expect(useProductShotsStore.getState().draft.product.forbiddenColors).toEqual(['米白'])
    // 受控输入框会在这里把「、」擦掉，用户就再也打不出第二个颜色。
    expect(colorInput().value).toBe('米白、')

    type('禁止色', '米白、浅灰')

    expect(useProductShotsStore.getState().draft.product.forbiddenColors).toEqual(['米白', '浅灰'])
  })

  it('picks an asset in the overlay and shows it at the top', async () => {
    useLibraryStore.setState({
      assets: [{ id: 'a1', name: '正面白底', imageId: 'asset-1', createdAt: 1, lastUsedAt: 1 }],
    })
    render()

    click(pickerButton())
    await settle()

    const picker = document.querySelector('[data-product-shots-product-picker]')
    if (!picker) throw new Error('no picker overlay')
    const card = [...picker.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('正面白底'),
    )
    if (!card) throw new Error('no asset card')
    click(card)

    expect(document.querySelector<HTMLSelectElement>('select[data-angle-for="a1"]')).not.toBeNull()
    expect(useProductShotsStore.getState().draft.productAssets).toEqual([
      { assetId: 'a1', angle: 'three-quarter' },
    ])

    const done = [...picker.querySelectorAll('button')].find((item) => item.textContent === '完成')
    if (!done) throw new Error('no done button')
    click(done)

    expect(document.querySelector('[data-product-shots-product-picker]')).toBeNull()
    expect(productBar().textContent).toContain('3/4 侧')
  })

  it('labels a version that swapped the product', async () => {
    useLibraryStore.setState({
      assets: [{ id: 'a1', name: '正面白底', imageId: 'asset-1', createdAt: 1, lastUsedAt: 1 }],
    })
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    while (useProductShotsStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    act(() => {
      useProductShotsStore.getState().toggleProductAsset('a1')
    })

    click(actionButton('replace-product'))
    await settle()

    const row = document.querySelector('[data-product-shots-version]')
    expect(row?.textContent).toContain('换产品')
    // 背景没动，那一句背景方案在这一版上是假的。
    expect(row?.textContent).not.toContain(PLAN.plan)
  })
})

describe('the result gallery', () => {
  async function withOneResult() {
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    while (useProductShotsStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    click(actionButton())
    await settle()
    act(() => {
      useStore.setState({ tasks: [finishedTask('task-1')] })
    })
  }

  it('says so while nothing has been produced', () => {
    render()

    expect(gallery().textContent).toContain('暂无结果')
  })

  it('switches between the grouped and the tiled view', async () => {
    await withOneResult()

    expect(gallery().querySelectorAll('[data-product-shots-gallery-row]')).toHaveLength(1)

    const tiled = [...gallery().querySelectorAll('button')].find(
      (button) => button.textContent === '平铺',
    )
    if (!tiled) throw new Error('no tiled button')
    click(tiled)

    expect(gallery().querySelectorAll('[data-product-shots-gallery-row]')).toHaveLength(0)
    expect(gallery().querySelectorAll('[data-product-shots-gallery-item]')).toHaveLength(1)
  })

  it('offers the export size, the export scope and the packed download', async () => {
    await withOneResult()

    expect(gallery().querySelector('[aria-label="导出尺寸"]')).not.toBeNull()
    expect(gallery().querySelector('[aria-label="导出范围"]')).not.toBeNull()
    const pack = [...gallery().querySelectorAll('button')].find(
      (button) => button.textContent === '打包下载 1 张',
    )
    expect(pack?.disabled).toBe(false)
  })

  it('takes a version as the chosen one from the gallery', async () => {
    await withOneResult()

    const choose = [...gallery().querySelectorAll('button')].find(
      (button) => button.textContent === '用这版',
    )
    if (!choose) throw new Error('no choose button')
    click(choose)
    await settle()

    const [version] = useProductShotsStore.getState().draft.images[0].versions
    expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(gallery().textContent).toContain('已选')
  })
})

describe('the plan drawer of one version', () => {
  async function withOneVersion() {
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    while (useProductShotsStore.getState().draft.id === null) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    click(actionButton())
    await settle()
  }

  function openDrawer(from: HTMLElement) {
    const open = [...from.querySelectorAll('button')].find(
      (button) => button.textContent === '查看方案',
    )
    if (!open) throw new Error('no plan drawer button')
    click(open)
  }

  it('keeps the drawer folded until the version bar asks for it', async () => {
    await withOneVersion()

    expect(drawer()).toBeNull()

    openDrawer(column('actions'))

    expect(drawer()?.textContent).toContain('提示词')
    expect(promptField().value).toBe(PLAN.prompt)
  })

  it('opens the same drawer from the gallery card', async () => {
    await withOneVersion()

    openDrawer(gallery())

    expect(drawer()).not.toBeNull()
  })

  it('rebuilds the prompt when the plan sentence is edited', async () => {
    await withOneVersion()
    openDrawer(column('actions'))

    write('方案句', '放进水泥灰的极简浴室')
    await settle()

    expect(promptField().value).toContain('放进水泥灰的极简浴室')
  })

  it('marks a hand written prompt and offers the way back', async () => {
    await withOneVersion()
    openDrawer(column('actions'))

    write('提示词', '我自己写的提示词')
    await settle()

    expect(drawer()?.textContent).toContain('手改')
    expect(column('actions').textContent).toContain('手改')

    const reset = [...(drawer()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '重置为 AI 版本',
    )
    if (!reset) throw new Error('no reset button')
    click(reset)
    await settle()

    expect(promptField().value).toContain(PLAN.plan)
  })

  it('submits another version on the prompt in the drawer', async () => {
    await withOneVersion()
    openDrawer(column('actions'))
    write('提示词', '我自己写的提示词')
    await settle()

    const regenerate = [...(drawer()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '按此重生成',
    )
    if (!regenerate) throw new Error('no regenerate button')
    click(regenerate)
    await settle()

    expect(submitPrepared.mock.calls[1][0].prompt).toBe('我自己写的提示词')
    expect(useProductShotsStore.getState().draft.images[0].versions).toHaveLength(2)
  })

  it('sets the language of the copy printed on the picture for the whole job', async () => {
    await withOneVersion()
    openDrawer(column('actions'))

    const english = [...(drawer()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '英文',
    )
    if (!english) throw new Error('no english button')
    click(english)
    await settle()

    expect(useProductShotsStore.getState().draft.language).toBe('en')
  })
})

function drawer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-product-shots-plan-drawer]')
}

function promptField(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>('[aria-label="提示词"]')
  if (!field) throw new Error('no prompt field')
  return field
}

/** 输入框与文本域各有自己的 value setter，React 只认对应原型上的那一个。 */
function write(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )
  if (!field) throw new Error(`no field labelled ${label}`)
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function batchBar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-product-shots-batch]')
  if (!element) throw new Error('no batch bar')
  return element
}

function batchButton(): HTMLButtonElement {
  const button = [...batchBar().querySelectorAll('button')].find(
    (item) => item.textContent === '批量跑',
  )
  if (!button) throw new Error('no batch button')
  return button
}

function gallery(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-product-shots-gallery]')
  if (!element) throw new Error('no gallery')
  return element
}

function actionButton(action = 'background'): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-product-shots-action="${action}"]`,
  )
  if (!button) throw new Error(`no ${action} action button`)
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
