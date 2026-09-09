// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import ProductShotsMode from '../../../../features/productShots/components/ProductShotsMode'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { SourceMatte } from '../../../../features/productShots/types'
import { ProductMatteError } from '../../../../lib/productMatte'
import { getPersistedState, useStore } from '../../../../store'
import { browserMatte, browserOnlyCapabilities, settleUntil as settleRounds } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const isClientCapabilityEnabled = vi.hoisted(() => vi.fn((_name: string) => true))
const storeImageFromFile = vi.hoisted(() =>
  vi.fn(async (file: File) => ({ id: `image-${file.name}`, dataUrl: `data:,${file.name}` })),
)
const ensureImageCached = vi.hoisted(() => vi.fn())
const submitPrepared = vi.hoisted(() => vi.fn())
const requestBackgroundPlan = vi.hoisted(() => vi.fn())
const requestSceneScan = vi.hoisted(() => vi.fn())
const segmentProduct = vi.hoisted(() => vi.fn())
const requestServerMatte = vi.hoisted(() => vi.fn())
const maskDataUrlToAlpha = vi.hoisted(() => vi.fn())
const assessMatte = vi.hoisted(() => vi.fn())
const alphaToInpaintMask = vi.hoisted(() => vi.fn())
const alphaToProductMask = vi.hoisted(() => vi.fn())
const modelSupportsNativeMask = vi.hoisted(() => vi.fn())
const storeImage = vi.hoisted(() => vi.fn())
const getImageDimensions = vi.hoisted(() => vi.fn())

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

vi.mock('../../../../lib/matteClient', () => ({ requestServerMatte }))

// jsdom 画不出缩略图，不给这一层喂图 <img> 一个都不会挂上去。
vi.mock('../../../../hooks/useImageThumbnail', () => ({
  useImageThumbnail: (imageId?: string) => (imageId ? { dataUrl: `data:,${imageId}` } : null),
}))

vi.mock('../../../../lib/productMatte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/productMatte')>()),
  segmentProduct,
  maskDataUrlToAlpha,
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

// jsdom 不解码图片，真的 getImageDimensions 会永远挂着，整条提交链跟着停住。
vi.mock('../../../../lib/canvasImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/canvasImage')>()),
  getImageDimensions,
}))

const LONG_FAILURE =
  '上游返回 400：提示词里带了被拒的词，换一句再试；这条原因很长，卡里默认只留一行'

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
  useStore.setState({ showToast: vi.fn(), tasks: [], matteOverlayHidden: false })
  useProductShotsStore.setState({
    jobs: [],
    swapStage: null,
    swapStartedAt: null,
    loadJobs: vi.fn().mockResolvedValue(undefined),
  })
  useProductShotsStore.getState().startNewJob()
  isClientCapabilityEnabled.mockImplementation(browserOnlyCapabilities)
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  submitPrepared.mockResolvedValue(['task-1'])
  requestBackgroundPlan.mockResolvedValue(PLAN)
  requestSceneScan.mockResolvedValue('photo')
  segmentProduct.mockResolvedValue(browserMatte())
  maskDataUrlToAlpha.mockResolvedValue({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
  assessMatte.mockReturnValue({ ok: true, coverage: 0.4 })
  alphaToInpaintMask.mockReturnValue('data:image/png;base64,MASK')
  alphaToProductMask.mockReturnValue('data:image/png;base64,PRODUCT-MASK')
  useLibraryStore.setState({ assets: [], loadAssets: vi.fn().mockResolvedValue(undefined) })
  modelSupportsNativeMask.mockReturnValue(true)
  storeImage.mockResolvedValue('mask-1')
  getImageDimensions.mockResolvedValue({ width: 2000, height: 2000 })
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

/** React 的每一轮都要包在 act 里，否则状态更新的警告会淹掉断言。 */
function tick() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function settle() {
  return settleRounds(() => false, tick)
}

function settleUntil(done: () => boolean) {
  return settleRounds(done, tick)
}

function column(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-product-shots-column="${name}"]`)
  if (!element) throw new Error(`no ${name} column`)
  return element
}

function progressLine(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-product-shots-progress]')
  if (!element) throw new Error('no progress line')
  return element
}

function versionPanel(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-product-shots-version-panel]')
  if (!element) throw new Error('no version panel')
  return element
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function hover(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

function unhover(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
}

function focus(element: Element) {
  act(() => {
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
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

/** 上传一张原图并等到它抠完：抠图没落地动作按钮是灰的，点了没用。 */
async function withMattedOriginal() {
  render()
  upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
  await settleUntil(() => !actionButton().disabled)
}

/** 一张原图跑完一次换背景，落下第一版。 */
async function withOneVersion() {
  await withMattedOriginal()
  click(actionButton())
  await settle()
}

function actionReasons(): Element[] {
  return [...column('actions').querySelectorAll('[data-product-shots-action-reason]')]
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

  it('shows the app tooltip on the source remove button', async () => {
    render()

    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await act(async () => {})
    const remove = document.querySelector('[aria-label="移除原图 1"]')
    if (!remove) throw new Error('no remove button')
    expect(remove.getAttribute('title')).toBeNull()
    expect(document.body.textContent).not.toContain('移除原图 1')

    hover(remove)
    expect(document.body.textContent).toContain('移除原图 1')

    unhover(remove)
    expect(document.body.textContent).not.toContain('移除原图 1')

    focus(remove)
    expect(document.body.textContent).toContain('移除原图 1')
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
      assets: [
        {
          id: 'a1',
          name: '主图白底',
          imageId: 'asset-1',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    render()

    click(sourceTab('素材库'))
    const open = [...column('sources').querySelectorAll('button')].find(
      (item) => item.textContent === '从素材库选原图',
    )
    if (!open) throw new Error('no library picker button')
    click(open)
    await settle()

    const picker = document.querySelector('[data-product-shots-source-picker]')
    if (!picker) throw new Error('no source picker overlay')
    expect(picker.textContent).toContain('选原图')
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
  it('counts through planning, matting and generating', async () => {
    const plan = deferred<typeof PLAN>()
    const alpha = deferred<{ alpha: Uint8ClampedArray; width: number; height: number }>()
    const submit = deferred<string[]>()
    await withMattedOriginal()
    // 原图那次抠图跑的是默认桩，这里挡的是这一次动作从 alpha 现算遮罩的那一段。
    requestBackgroundPlan.mockReturnValue(plan.promise)
    maskDataUrlToAlpha.mockReturnValue(alpha.promise)
    submitPrepared.mockReturnValue(submit.promise)

    click(actionButton())
    await settle()
    expect(progressLine().textContent).toContain('方案中')

    plan.resolve(PLAN)
    await settle()
    expect(progressLine().textContent).toContain('抠图中')

    alpha.resolve({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
    await settle()
    expect(progressLine().textContent).toContain('生成中')

    submit.resolve(['task-1'])
    await settle()
    expect(document.querySelector('[data-product-shots-progress]')).toBeNull()
  })

  it('keeps the three action buttons on their own labels while a stage runs', async () => {
    const plan = deferred<typeof PLAN>()
    await withMattedOriginal()
    requestBackgroundPlan.mockReturnValue(plan.promise)

    click(actionButton())
    await settle()

    for (const [action, label] of [
      ['background', '换背景'],
      ['replace-product', '换产品'],
      ['remix', '借创意重做'],
    ]) {
      expect(actionButton(action).textContent).toBe(label)
      expect(actionButton(action).disabled).toBe(true)
    }
    expect(progressLine().textContent).toContain('方案中')

    plan.resolve(PLAN)
    await settle()
  })

  it('puts the new version on the bar with its plan label', async () => {
    await withMattedOriginal()

    click(actionButton())
    await settle()

    const [row] = document.querySelectorAll('[data-product-shots-version]')
    expect(row.textContent).toContain('第 1 版')
    expect(row.textContent).toContain(PLAN.plan)
    expect(row.textContent).toContain('排队')
  })

  it('marks a prompt-only version with why the matte was skipped', async () => {
    await withMattedOriginal()
    modelSupportsNativeMask.mockReturnValue(false)

    click(actionButton())
    await settle()

    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain(
      '未抠图 · 不支持',
    )
  })

  it('opens the mask editor on the version mask, brush painting the kept area', async () => {
    await withMattedOriginal()

    click(actionButton())
    await settle()
    const edit = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '编辑蒙版',
    )
    if (!edit) throw new Error('no mask edit button')
    click(edit)
    await settle()

    expect(useStore.getState().maskEditorImageId).toBe('image-主图.png')
    expect(useStore.getState().maskEditorSession?.keepSemantics).toBe(true)
  })

  it('marks a version whose source image is small', async () => {
    getImageDimensions.mockResolvedValue({ width: 864, height: 864 })
    await withMattedOriginal()

    click(actionButton())
    await settle()

    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain(
      '源图分辨率低',
    )
  })

  it('shows which backend produced the matte', async () => {
    await withMattedOriginal()

    click(actionButton())
    await settle()

    expect(document.querySelector('[data-product-shots-version]')?.textContent).toContain(
      'U²-Netp · CPU',
    )
  })

  it('takes a finished version as the chosen one', async () => {
    await withMattedOriginal()
    click(actionButton())
    await settle()
    act(() => {
      useStore.setState({
        tasks: [finishedTask('task-1')],
      })
    })

    const choose = [...versionPanel().querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '用这版',
    )
    if (!choose) throw new Error('no choose button')
    click(choose)
    await settle()

    const [version] = useProductShotsStore.getState().draft.images[0].versions
    expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(
      [...versionPanel().querySelectorAll('button')]
        .find((button) => button.getAttribute('aria-label') === '取消选用')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('switches the middle preview between the original and a version', async () => {
    await withMattedOriginal()
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
    await withMattedOriginal()
    click(actionButton())
    await settle()

    const toggle = [...versionPanel().querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '看蒙版',
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
    // 批量会等每张原图的抠图落定，图还在抠时点开始只是排队。
    await settleUntil(() => {
      const { draft } = useProductShotsStore.getState()
      return draft.id !== null && draft.images.every((item) => item.sourceMatte?.status === 'ready')
    })
  }

  it('offers the images the sample leaves behind', async () => {
    await withTwoImages()

    expect(batchBar().textContent).toContain('对剩下的 1 张')
    expect(batchButton().disabled).toBe(false)
  })

  it('counts the images through and lands them on done', async () => {
    await withTwoImages()

    click(batchButton())
    await settleUntil(() => useProductShotsStore.getState().batch?.running === false)

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

  function pickProductButton(): HTMLButtonElement {
    const button = [...column('actions').querySelectorAll('button')].find(
      (item) => item.textContent === '选产品素材',
    )
    if (!button) throw new Error('no pick product button')
    return button
  }

  it('holds the product swap back until a product asset is picked', () => {
    render()

    expect(actionButton('replace-product').disabled).toBe(true)
    expect(pickProductButton()).toBeTruthy()
  })

  it('holds the creative remix back until a product asset is picked', () => {
    render()

    expect(actionButton('remix').disabled).toBe(true)
    expect(pickProductButton()).toBeTruthy()
  })

  it('opens the picker from the reason a held back action gives', async () => {
    render()

    click(pickProductButton())
    await settle()

    expect(document.querySelector('[data-product-shots-product-picker]')).not.toBeNull()
  })

  it('says what the product at the top is used for', () => {
    render()

    expect(productBar().textContent).toContain('换产品 / 借创意重做时放进画面的产品')
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
      assets: [
        {
          id: 'a1',
          name: '正面白底',
          imageId: 'asset-1',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
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
      assets: [
        {
          id: 'a1',
          name: '正面白底',
          imageId: 'asset-1',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    await withMattedOriginal()
    act(() => {
      useProductShotsStore.getState().toggleProductAsset('a1')
    })

    click(actionButton('replace-product'))
    await settle()

    const row = document.querySelector('[data-product-shots-version]')
    expect(row?.textContent).toContain('换产品')
    // 背景没动，那一句背景方案在这一版上是假的。
    expect(row?.textContent).not.toContain(PLAN.plan)

    const open = [...(row?.querySelectorAll('button') ?? [])].find(
      (button) => button.getAttribute('aria-label') === '查看方案',
    )
    if (!open) throw new Error('no plan drawer button')
    click(open)

    expect(document.querySelector('[aria-label="方案句"]')).toBeNull()
    expect(document.querySelector('[aria-label="提示词"]')).not.toBeNull()
  })
})

describe('the right column grouped into settings and generation', () => {
  const PRODUCT_REASON = '换产品与借创意重做需要先选产品素材'

  function headings(): string[] {
    return [...column('actions').querySelectorAll('h2')].map((item) => item.textContent ?? '')
  }

  it('orders the column as settings and generation', () => {
    render()

    expect(headings()).toEqual(['设置', '生成'])
  })

  it('puts the three actions on one row', () => {
    render()

    const row = actionButton('background').parentElement
    expect(actionButton('replace-product').parentElement).toBe(row)
    expect(actionButton('remix').parentElement).toBe(row)
  })

  it('gives the held back actions one reason, not one per button', () => {
    render()

    expect(actionReasons().map((item) => item.textContent)).toEqual([PRODUCT_REASON])
    expect(column('actions').textContent?.split(PRODUCT_REASON)).toHaveLength(2)
  })

  it('drops the reason once a product asset is picked', () => {
    useLibraryStore.setState({
      assets: [
        {
          id: 'a1',
          name: '正面白底',
          imageId: 'asset-1',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    render()

    expect(column('actions').textContent).toContain('产品素材：未选')

    act(() => {
      useProductShotsStore.getState().toggleProductAsset('a1')
    })

    expect(actionReasons()).toEqual([])
    expect(column('actions').textContent).toContain('更换')
  })

  it('keeps the settings where they are', () => {
    render()

    const settings = column('actions').querySelector('[data-product-shots-settings]')
    expect(settings?.textContent).toContain('偏好')
    expect(settings?.textContent).toContain('每张几版')
    expect(settings?.querySelector('[role="group"][aria-label="与竞品的距离"]')).not.toBeNull()
  })
})

describe('holding the actions back until the matte lands', () => {
  function pickProduct() {
    useLibraryStore.setState({
      assets: [
        {
          id: 'a1',
          name: '正面白底',
          imageId: 'asset-1',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    act(() => {
      useProductShotsStore.getState().toggleProductAsset('a1')
    })
  }

  async function withMattingOriginal(): Promise<(matte: ReturnType<typeof browserMatte>) => void> {
    const matte = deferred<ReturnType<typeof browserMatte>>()
    segmentProduct.mockReturnValue(matte.promise)
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await settleUntil(() => useProductShotsStore.getState().draft.id !== null)
    return matte.resolve
  }

  it('holds the masked actions back while the original is still being matted', async () => {
    const finishMatte = await withMattingOriginal()

    expect(actionButton('background').disabled).toBe(true)
    expect(actionButton('replace-product').disabled).toBe(true)
    expect(actionReasons()[0]?.textContent).toBe('抠图中')

    finishMatte(browserMatte())
    await settleUntil(() => !actionButton().disabled)

    expect(actionButton('background').disabled).toBe(false)
    expect(actionReasons().map((item) => item.textContent)).not.toContain('抠图中')
  })

  it('lets the maskless action through while the matte is still running', async () => {
    const finishMatte = await withMattingOriginal()
    pickProduct()

    expect(actionButton('remix').disabled).toBe(false)

    finishMatte(browserMatte())
    await settle()
  })

  it('offers a retry when the matte failed and lets the actions through once it lands', async () => {
    segmentProduct.mockRejectedValueOnce(new ProductMatteError('timeout', '抠图超时'))
    render()
    upload('上传原图', new File(['x'], '主图.png', { type: 'image/png' }))
    await settleUntil(() => actionReasons()[0]?.textContent?.startsWith('抠图失败') === true)

    expect(actionButton('background').disabled).toBe(true)
    expect(useProductShotsStore.getState().draft.images[0].sourceMatte).toMatchObject({
      status: 'failed',
    })

    const retry = [...(actionReasons()[0]?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '重试抠图',
    )
    if (!retry) throw new Error('no matte retry button')
    click(retry)
    await settleUntil(() => !actionButton().disabled)

    expect(actionButton('background').disabled).toBe(false)
    expect(useProductShotsStore.getState().draft.images[0].sourceMatte).toMatchObject({
      status: 'ready',
    })
  })
})

describe('the version list in the centre column', () => {
  function versionRow(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-product-shots-version]')
    if (!element) throw new Error('no version row')
    return element
  }

  function errorToggle(): HTMLButtonElement {
    const element = versionRow().querySelector<HTMLButtonElement>(
      '[data-product-shots-version-error-toggle]',
    )
    if (!element) throw new Error('no error toggle')
    return element
  }

  it('puts the version list under the preview and out of the settings column', async () => {
    await withOneVersion()

    expect(column('center').contains(column('preview'))).toBe(true)
    expect(column('center').contains(versionPanel())).toBe(true)
    expect(
      column('preview').compareDocumentPosition(versionPanel()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(column('actions').contains(versionPanel())).toBe(false)
    expect(column('actions').querySelector('[data-product-shots-version]')).toBeNull()
  })

  it('lays the card out as the thumbnail, the meta column and the operations', async () => {
    await withOneVersion()

    expect(versionRow().className).toContain('grid-cols-[72px_minmax(0,1fr)_auto]')
    expect(versionRow().children).toHaveLength(3)
  })

  it('wraps the chips instead of squeezing them and keeps the action label whole', async () => {
    await withOneVersion()

    const tags = versionRow().querySelector<HTMLElement>('[data-product-shots-version-tags]')
    expect(tags?.className).toContain('flex-wrap')
    expect(tags?.className).not.toContain('whitespace-nowrap')

    const title = versionRow().querySelector<HTMLElement>('[data-product-shots-version-title]')
    const action = [...(title?.children ?? [])].find((item) => item.textContent === '换背景')
    expect(action?.className).toContain('shrink-0')
    expect(action?.className).not.toContain('truncate')
  })

  it('folds a failure to one line and unfolds the whole reason on demand', async () => {
    await withOneVersion()
    act(() => {
      useStore.setState({
        tasks: [{ ...finishedTask('task-1'), status: 'error', error: LONG_FAILURE }],
      })
    })

    const folded = errorToggle().previousElementSibling
    expect(folded?.textContent).toBe(LONG_FAILURE)
    expect(folded?.className).toContain('truncate')
    expect(errorToggle().textContent).toBe('展开')

    click(errorToggle())

    const unfolded = errorToggle().previousElementSibling
    expect(unfolded?.textContent).toBe(LONG_FAILURE)
    expect(unfolded?.className).not.toContain('truncate')
    expect(errorToggle().textContent).toBe('收起')
  })
})

describe('the result gallery', () => {
  async function withOneResult() {
    await withMattedOriginal()
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

    const choose = gallery().querySelector<HTMLButtonElement>('[data-product-shots-choose]')
    if (!choose) throw new Error('no choose button')
    click(choose)
    await settle()

    const [version] = useProductShotsStore.getState().draft.images[0].versions
    expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(
      gallery().querySelector('[data-product-shots-choose]')?.getAttribute('aria-pressed'),
    ).toBe('true')
  })
})

describe('the plan drawer of one version', () => {
  function openDrawer(from: HTMLElement) {
    // 版本条上是文字按钮，总览卡上是图标按钮，两处认同一个名字。
    const open = [...from.querySelectorAll('button')].find(
      (button) =>
        button.textContent === '查看方案' || button.getAttribute('aria-label') === '查看方案',
    )
    if (!open) throw new Error('no plan drawer button')
    click(open)
  }

  it('keeps the drawer folded until the version bar asks for it', async () => {
    await withOneVersion()

    expect(drawer()).toBeNull()

    openDrawer(versionPanel())

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
    openDrawer(versionPanel())

    write('方案句', '放进水泥灰的极简浴室')
    await settle()

    expect(promptField().value).toContain('放进水泥灰的极简浴室')
  })

  it('marks a hand written prompt and offers the way back', async () => {
    await withOneVersion()
    openDrawer(versionPanel())

    write('提示词', '我自己写的提示词')
    await settle()

    expect(drawer()?.textContent).toContain('手改')
    expect(versionPanel().textContent).toContain('手改')

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
    openDrawer(versionPanel())
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
    openDrawer(versionPanel())

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

function fileDragEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files,
      types: ['Files'],
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    },
  })
  return event
}

function fireDrag(target: Element, type: string, files: File[]) {
  act(() => {
    target.dispatchEvent(fileDragEvent(type, files))
  })
}

function firePaste(files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    },
  })
  act(() => {
    document.dispatchEvent(event)
  })
}

describe('dropping and pasting images into the source list', () => {
  const png = () => new File(['x'], '主图.png', { type: 'image/png' })
  const pdf = () => new File(['x'], '说明.pdf', { type: 'application/pdf' })

  function dropZone(): HTMLElement {
    const element = column('sources').querySelector<HTMLElement>('[data-image-dropzone]')
    if (!element) throw new Error('no drop zone')
    return element
  }

  it('marks the list as a drop target while a file hovers it', () => {
    render()

    fireDrag(dropZone(), 'dragenter', [png()])
    expect(dropZone().textContent).toContain('松开即上传')

    fireDrag(dropZone(), 'dragleave', [png()])
    expect(dropZone().textContent).not.toContain('松开即上传')
  })

  it('imports every dropped image and refuses the rest', async () => {
    render()

    fireDrag(dropZone(), 'dragenter', [png(), pdf()])
    fireDrag(dropZone(), 'drop', [png(), pdf()])
    await settle()

    expect(useProductShotsStore.getState().draft.images).toHaveLength(1)
    expect(dropZone().textContent).not.toContain('松开即上传')
    expect(useStore.getState().showToast).toHaveBeenCalledWith('只支持图片文件', 'error')
  })

  it('offers the empty list as a second upload button', () => {
    render()
    const input = document.querySelector<HTMLInputElement>('input[aria-label="上传原图"]')
    if (!input) throw new Error('no file input')
    const openPicker = vi.spyOn(input, 'click')

    const placeholder = [...dropZone().querySelectorAll('button')].find(
      (item) => item.textContent === '拖入图片，或点击上传',
    )
    if (!placeholder) throw new Error('no empty state button')
    click(placeholder)

    expect(openPicker).toHaveBeenCalled()
  })

  it('takes a pasted image while the product shots mode is in front', async () => {
    useStore.setState({ appMode: 'product' })
    render()

    firePaste([png()])
    await settle()

    expect(useProductShotsStore.getState().draft.images).toHaveLength(1)
  })

  it('ignores a paste that belongs to the workbench behind it', async () => {
    useStore.setState({ appMode: 'browse' })
    render()

    firePaste([png()])
    await settle()

    expect(useProductShotsStore.getState().draft.images).toEqual([])
  })

  it('takes a drop in the product asset overlay as an upload', async () => {
    const importAssetFiles = vi.fn().mockResolvedValue(undefined)
    useLibraryStore.setState({ importAssetFiles })
    render()
    const open = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === '选素材',
    )
    if (!open) throw new Error('no product picker button')
    click(open)
    await settle()

    const zone = document.querySelector<HTMLElement>(
      '[data-product-shots-product-picker][data-image-dropzone]',
    )
    if (!zone) throw new Error('no drop zone in the product picker')
    fireDrag(zone, 'dragenter', [png()])
    expect(zone.textContent).toContain('松开即上传')

    fireDrag(zone, 'drop', [png(), pdf()])
    await settle()

    expect(importAssetFiles).toHaveBeenCalled()
    expect(importAssetFiles.mock.calls[0][0]).toHaveLength(1)
  })
})

describe('the matte laid over the source image', () => {
  const ready = (patch: Partial<Extract<SourceMatte, { status: 'ready' }>> = {}): SourceMatte => ({
    status: 'ready',
    backend: 'wasm-u2netp',
    alphaImageId: 'alpha-1',
    targetImageId: 'image-1',
    previewImageId: 'matte-1',
    edited: false,
    ...patch,
  })

  /** null = 这张还在抠，身上还没有蒙版。 */
  function seed(...mattes: Array<SourceMatte | null>) {
    const images = mattes.map((sourceMatte, index) => ({
      imageId: `image-${index + 1}`,
      versions: [],
      ...(sourceMatte ? { sourceMatte } : {}),
    }))
    act(() => {
      useProductShotsStore.setState((s) => ({
        draft: { ...s.draft, id: 'job-1', images },
        selectedImageId: images[0]?.imageId ?? null,
        mattingImageIds: images
          .filter((_, index) => mattes[index] === null)
          .map((image) => image.imageId),
      }))
    })
    render()
  }

  function overlayIn(name: string): Element | null {
    return column(name).querySelector('img[alt="蒙版"]')
  }

  function overlaySwitch(): HTMLInputElement {
    const box = column('preview').querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!box) throw new Error('no matte switch')
    return box
  }

  function button(name: string, label: string): HTMLButtonElement {
    const found = [...column(name).querySelectorAll('button')].find(
      (item) => item.textContent === label,
    )
    if (!found) throw new Error(`no ${label} button`)
    return found
  }

  it('lays the matte over the original and over the thumbnail', () => {
    seed(ready())

    expect(overlaySwitch().checked).toBe(true)
    expect(overlayIn('preview')).not.toBeNull()
    expect(overlayIn('sources')).not.toBeNull()
  })

  it('drops the overlay off the preview once the switch is off, and remembers it', () => {
    seed(ready())

    act(() => overlaySwitch().click())

    expect(overlayIn('preview')).toBeNull()
    expect(overlayIn('sources')).not.toBeNull()
    expect(getPersistedState(useStore.getState()).matteOverlayHidden).toBe(true)

    act(() => root.render(<ProductShotsMode />))

    expect(overlaySwitch().checked).toBe(false)
  })

  it('shows the plain original while the matte is still running', () => {
    seed(null)

    expect(overlayIn('preview')).toBeNull()
    expect(column('preview').textContent).toContain('抠图中')
  })

  it('names the matte state on the source row', () => {
    seed(ready())

    expect(column('sources').querySelector('[data-product-shots-source]')?.textContent).toContain(
      '已抠 · U²-Netp · CPU',
    )
  })

  it('opens the mask editor on the image matte, brush painting the kept area', async () => {
    seed(ready())

    click(button('preview', '改蒙版'))
    await settle()

    expect(useStore.getState().maskEditorImageId).toBe('image-1')
    expect(useStore.getState().maskEditorSession?.keepSemantics).toBe(true)
  })

  it('reports an unreliable matte without holding the actions back', () => {
    seed(ready({ agreement: 'box-mismatch' }))

    expect(column('actions').textContent).toContain('蒙版不可靠')
    expect(actionButton().disabled).toBe(false)
  })

  it('carries the chip into the batch list', () => {
    act(() => {
      useProductShotsStore.setState({
        batch: {
          items: [
            { imageId: 'image-1', state: 'done', error: null },
            { imageId: 'image-2', state: 'pending', error: null },
          ],
          running: false,
          stopRequested: false,
          startedAt: null,
          stage: null,
        },
      })
    })
    seed(ready(), ready({ agreement: 'box-mismatch' }))

    const rows = [...batchBar().querySelectorAll('[data-product-shots-batch-item]')]

    expect(rows[0].textContent).toContain('已抠 · U²-Netp · CPU')
    expect(rows[1].textContent).toContain('蒙版不可靠')
  })
})
