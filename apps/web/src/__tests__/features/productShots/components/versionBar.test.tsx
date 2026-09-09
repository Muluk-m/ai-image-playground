// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VersionBar from '../../../../features/productShots/components/VersionBar'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotVersion } from '../../../../features/productShots/types'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const downloadImagesByIds = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/downloadImages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/downloadImages')>()),
  downloadImagesByIds,
}))

vi.mock('../../../../features/library/components/AssetThumb', () => ({
  default: ({ alt }: { alt: string }) => <span>{alt}</span>,
}))

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 52_000,
    ...patch,
  }
}

function version(id: string, patch: Partial<ProductShotVersion> = {}): ProductShotVersion {
  return {
    id,
    taskId: `task-${id}`,
    plan: '放进有窗光的日式木质浴室，晨光从左侧斜进来，地面是浅色柚木',
    prompt: 'p',
    masked: true,
    mode: 'background',
    mattePreviewImageId: `matte-${id}`,
    maskImageId: `mask-${id}`,
    createdAt: 1,
    ...patch,
  }
}

const setLightboxImageId = vi.fn<(id: string | null, list?: string[]) => void>()
const showToast = vi.fn<(message: string, type?: 'info' | 'success' | 'error') => void>()
const retryVersion = vi.fn<(versionId: string) => Promise<void>>()
const editSourceMask = vi.fn<(imageId: string) => Promise<void>>()
const regenerateFromVersion = vi.fn<(versionId: string, maskOnly?: boolean) => Promise<void>>()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  retryVersion.mockResolvedValue(undefined)
  editSourceMask.mockResolvedValue(undefined)
  regenerateFromVersion.mockResolvedValue(undefined)
  downloadImagesByIds.mockResolvedValue({ success: 1, failed: 0 })
  useStore.setState({
    showToast,
    setLightboxImageId,
    tasks: [
      task('task-v1', { outputImages: ['out-1'] }),
      task('task-v2', { status: 'error', error: '上游报错', outputImages: [] }),
    ],
  })
  useProductShotsStore.setState({
    retryVersion,
    editSourceMask,
    regenerateFromVersion,
    selectedImageId: 'src-1',
    previewVersionId: null,
    matteOverlayVersionId: null,
    draft: {
      id: 'job-1',
      name: '折叠浴缸',
      preference: '',
      versionsPerImage: 1,
      mode: 'background',
      level: 'high',
      productAssets: [],
      product: { name: '', features: '', mainColor: '', forbiddenColors: [] },
      language: 'zh',
      createdAt: 1,
      images: [
        {
          imageId: 'src-1',
          versions: [version('v1'), version('v2')],
          sourceMatte: {
            status: 'ready',
            backend: 'wasm-u2netp',
            alphaImageId: 'alpha-1',
            targetImageId: 'src-1',
            previewImageId: 'matte-1',
            edited: false,
          },
        },
      ],
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function render() {
  act(() => root.render(<VersionBar />))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function doubleClick(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
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

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-product-shots-version]')]
}

function row(index: number): HTMLElement {
  const found = rows()[index]
  if (!found) throw new Error(`no version row ${index}`)
  return found
}

function part(selector: string, scope: ParentNode = document): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}

function iconButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no icon button labelled ${label}`)
  return found
}

function chosenVersionId(): string | undefined {
  return useProductShotsStore.getState().draft.images[0]?.chosenVersionId
}

describe('the version bar of the selected source image', () => {
  it('keeps the title line from wrapping and lets the tag line wrap', () => {
    render()

    const title = part('[data-product-shots-version-title]', row(0))
    expect(title.textContent).toContain('第 1 版')
    expect(title.textContent).toContain('换背景')
    expect(title.textContent).toContain('52s')
    expect(title.textContent).not.toContain('完成')
    expect(title.className).toContain('whitespace-nowrap')
    expect(part('[data-product-shots-version-tags]', row(0)).className).toContain('flex-wrap')
  })

  it('spells the matte failure out instead of squeezing it to one glyph', () => {
    useProductShotsStore.setState((state) => ({
      draft: {
        ...state.draft,
        images: [
          {
            imageId: 'src-1',
            versions: [
              version('v1', {
                masked: false,
                matte: { ok: false, reason: 'failed' },
                lowResSource: true,
              }),
            ],
          },
        ],
      },
    }))
    render()

    const tags = part('[data-product-shots-version-tags]', row(0))
    expect(tags.textContent).toContain('未抠图 · 运行错误')
    expect(tags.textContent).toContain('源图分辨率低')
    // 挤扁的根因是标签会被压到内容以下，短标签一律不许收缩。
    const [matte, lowRes] = tags.children
    expect(matte?.getAttribute('title')).toBe('未抠图 · 运行错误')
    expect(lowRes?.className).toContain('shrink-0')
  })

  it('folds the plan sentence to two lines and unfolds it on click', () => {
    render()
    const plan = part('[data-product-shots-version-plan]', row(0))

    expect(plan.className).toContain('line-clamp-2')
    expect(plan.getAttribute('aria-expanded')).toBe('false')

    click(plan)

    const unfolded = part('[data-product-shots-version-plan]', row(0))
    expect(unfolded.className).not.toContain('line-clamp-2')
    expect(unfolded.getAttribute('aria-expanded')).toBe('true')
  })

  it('previews the version in the middle column on a single click', () => {
    render()

    click(part('[data-product-shots-version-preview]', row(0)))

    expect(useProductShotsStore.getState().previewVersionId).toBe('v1')
  })

  it('opens the lightbox on a double click', () => {
    render()

    doubleClick(part('[data-product-shots-version-preview]', row(0)))

    expect(setLightboxImageId).toHaveBeenCalledWith('out-1', ['out-1'])
  })

  it('picks the version with the check and unpicks it on a second click', () => {
    render()

    click(iconButton('用这版', row(0)))
    expect(chosenVersionId()).toBe('v1')

    click(iconButton('取消选用', row(0)))
    expect(chosenVersionId()).toBeUndefined()
  })

  it('names every icon action for the screen reader and leaves no native title', () => {
    render()

    for (const label of ['查看方案', '看蒙版', '编辑蒙版', '用此蒙版重生成', '用这版', '下载']) {
      const button = iconButton(label, row(0))
      expect(button.getAttribute('aria-label')).toBe(label)
      expect(button.getAttribute('title')).toBeNull()
      expect(button.disabled).toBe(false)
    }
  })

  it('shows the app tooltip on hover and on keyboard focus', () => {
    render()

    const button = iconButton('看蒙版', row(0))
    expect(document.body.textContent).not.toContain('看蒙版')

    hover(button)
    expect(document.body.textContent).toContain('看蒙版')

    unhover(button)
    expect(document.body.textContent).not.toContain('看蒙版')

    focus(button)
    expect(document.body.textContent).toContain('看蒙版')
  })

  it('reruns a failed version and regenerates a finished one on its own mask', () => {
    render()

    click(iconButton('重跑', row(1)))
    expect(retryVersion).toHaveBeenCalledWith('v2')

    click(iconButton('用此蒙版重生成', row(0)))
    expect(regenerateFromVersion).toHaveBeenCalledWith('v1', true)
  })

  it('downloads the version image at its own size', () => {
    render()

    click(iconButton('下载', row(0)))

    expect(downloadImagesByIds).toHaveBeenCalledWith(['out-1'], expect.any(String))
  })
})
