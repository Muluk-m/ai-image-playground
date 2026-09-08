// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResultGallery from '../../../../features/productShots/components/ResultGallery'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotVersion } from '../../../../features/productShots/types'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const downloadExportZip = vi.hoisted(() => vi.fn())
const downloadExportedImage = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/imageExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/imageExport')>()),
  downloadExportZip,
  downloadExportedImage,
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
    elapsed: 1,
    ...patch,
  }
}

function version(id: string) {
  return { id, taskId: `task-${id}`, plan: '木质浴室', prompt: 'p', masked: true, createdAt: 1 }
}

/** 一个能被外部推进的 promise，让测试停在打包中间观察读秒文案。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const showToast = vi.fn<(message: string, type?: 'info' | 'success' | 'error') => void>()
const setLightboxImageId = vi.fn<(id: string | null, list?: string[]) => void>()
const retryVersion = vi.fn<(versionId: string) => Promise<void>>()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  retryVersion.mockResolvedValue(undefined)
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
    selectedImageId: null,
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
        { imageId: 'src-1', versions: [version('v1'), version('v2')], chosenVersionId: 'v1' },
      ],
    },
  })
  downloadExportZip.mockResolvedValue({ count: 1, failed: 0 })
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
  act(() => root.render(<ResultGallery />))
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

function buttonLabelled(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

function iconButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no icon button labelled ${label}`)
  return found
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-product-shots-gallery-item]')]
}

function part(selector: string, scope: ParentNode = document): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}

function chosenVersionId(): string | undefined {
  return useProductShotsStore.getState().draft.images[0]?.chosenVersionId
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function showVersions(versions: ProductShotVersion[]) {
  useProductShotsStore.setState((state) => ({
    draft: { ...state.draft, images: [{ imageId: 'src-1', versions }] },
  }))
}

function chooseNothing() {
  useProductShotsStore.setState((state) => ({
    draft: {
      ...state.draft,
      images: state.draft.images.map(({ chosenVersionId: _dropped, ...image }) => image),
    },
  }))
}

describe('the results overview', () => {
  it('reruns a failed version in place', () => {
    render()
    const failed = cards().find((item) => item.textContent?.includes('失败'))
    if (!failed) throw new Error('no failed version card')
    click(iconButton('重跑', failed))

    expect(retryVersion).toHaveBeenCalledWith('v2')
  })

  it('previews the version in the middle column on a single click', () => {
    render()

    click(part('[data-product-shots-preview]', cards()[0] as HTMLElement))

    expect(useProductShotsStore.getState().selectedImageId).toBe('src-1')
    expect(useProductShotsStore.getState().previewVersionId).toBe('v1')
  })

  it('opens the lightbox on a double click', () => {
    render()

    doubleClick(part('[data-product-shots-preview]', cards()[0] as HTMLElement))

    expect(setLightboxImageId).toHaveBeenCalledWith('out-1', ['out-1'])
  })

  it('picks the version with the check dot and unpicks it on a second click', () => {
    chooseNothing()
    render()

    click(part('[data-product-shots-choose]', cards()[0] as HTMLElement))
    expect(chosenVersionId()).toBe('v1')

    click(part('[data-product-shots-choose]', cards()[0] as HTMLElement))
    expect(chosenVersionId()).toBeUndefined()
  })

  it('names every icon action for the pointer and the screen reader', () => {
    render()
    const [done] = cards()
    if (!done) throw new Error('no version card')

    for (const label of ['查看方案', '下载', '放大查看', '取消选用']) {
      const button = iconButton(label, done)
      expect(button.getAttribute('aria-label')).toBe(label)
      // 原生 title 和应用提示会叠着出，只留应用提示那一份。
      expect(button.getAttribute('title')).toBeNull()
      expect(button.disabled).toBe(false)
    }
  })

  it('shows the app tooltip on a card icon button on hover and on keyboard focus', () => {
    render()
    const [done] = cards()
    if (!done) throw new Error('no version card')

    const button = iconButton('放大查看', done)
    expect(document.body.textContent).not.toContain('放大查看')

    hover(button)
    expect(document.body.textContent).toContain('放大查看')

    unhover(button)
    expect(document.body.textContent).not.toContain('放大查看')

    focus(button)
    expect(document.body.textContent).toContain('放大查看')
  })

  it('keeps the version title on one line', () => {
    render()

    expect(part('[data-product-shots-version-title]').className).toContain('whitespace-nowrap')
    expect(part('[data-product-shots-version-tags]').className).toContain('whitespace-nowrap')
    // 格子窄，动作标签在这里仍然省略，跟宽版的版本条不一样。
    const [, action] = part('[data-product-shots-version-title]').children
    expect(action?.className).toContain('truncate')
  })

  it('previews the source image from the grouped view', () => {
    render()
    useProductShotsStore.setState({ selectedImageId: 'src-1', previewVersionId: 'v1' })

    click(part('[data-product-shots-gallery-source]'))

    expect(useProductShotsStore.getState().selectedImageId).toBe('src-1')
    expect(useProductShotsStore.getState().previewVersionId).toBeNull()
  })

  it('counts the seconds on the export button while it packs', async () => {
    const packing = deferred<{ count: number; failed: number }>()
    downloadExportZip.mockReturnValue(packing.promise)
    render()

    click(buttonLabelled('打包下载 1 张'))
    await settle()

    const packButton = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('打包中'),
    )
    expect(packButton?.disabled).toBe(true)

    packing.resolve({ count: 1, failed: 0 })
    await settle()

    expect(showToast).toHaveBeenCalledWith('已打包 1 张', 'success')
  })

  it('says how many unfinished versions it left out', async () => {
    render()

    click(buttonLabelled('全部版'))
    click(buttonLabelled('打包下载 1 张'))
    await settle()

    expect(downloadExportZip).toHaveBeenCalledWith(
      '折叠浴缸',
      [{ path: '折叠浴缸/01-v1.png', imageId: 'out-1', fit: 'crop' }],
      expect.anything(),
    )
    expect(showToast).toHaveBeenCalledWith('已打包 1 张，已跳过 1 个未完成版本', 'success')
  })

  it('reports a package that blew up instead of leaving no trace', async () => {
    downloadExportZip.mockRejectedValue(new Error('画布不可用'))
    render()

    click(buttonLabelled('打包下载 1 张'))
    await settle()

    expect(showToast).toHaveBeenCalledWith('打包失败：画布不可用', 'error')
    expect(buttonLabelled('打包下载 1 张').disabled).toBe(false)
  })

  it('exports the chosen version once one is picked', () => {
    render()

    expect(buttonLabelled('选用版').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).not.toContain('未选用，导出全部')
    expect(buttonLabelled('打包下载 1 张').disabled).toBe(false)
  })

  it('falls back to every version, labelled, while nothing is picked', () => {
    chooseNothing()
    render()

    expect(buttonLabelled('全部版').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('未选用，导出全部')
    expect(buttonLabelled('打包下载 1 张').disabled).toBe(false)
  })

  it('marks a masked action that fell back to a prompt-only version', () => {
    showVersions([{ ...version('v1'), masked: false, mode: 'background' }])
    render()

    expect(document.body.textContent).toContain('未抠图')
  })

  it('leaves the matte tag off a version whose action never mattes', () => {
    showVersions([{ ...version('v1'), masked: false, mode: 'remix' }])
    render()

    expect(document.body.textContent).not.toContain('未抠图')
  })

  it('blocks the package with a reason when the scope holds nothing', () => {
    chooseNothing()
    render()

    click(buttonLabelled('选用版'))

    const packButton = buttonLabelled('打包下载 0 张')
    expect(packButton.disabled).toBe(true)
    expect(document.body.textContent).toContain('未选用版本')
  })
})
