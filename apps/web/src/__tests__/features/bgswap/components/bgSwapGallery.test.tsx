// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BgSwapGallery from '../../../../features/bgswap/components/BgSwapGallery'
import { useBgSwapStore } from '../../../../features/bgswap/store'
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
const retryVersion = vi.fn<(versionId: string) => Promise<void>>()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  retryVersion.mockResolvedValue(undefined)
  useStore.setState({
    showToast,
    tasks: [
      task('task-v1', { outputImages: ['out-1'] }),
      task('task-v2', { status: 'error', error: '上游报错', outputImages: [] }),
    ],
  })
  useBgSwapStore.setState({
    retryVersion,
    draft: {
      id: 'job-1',
      name: '折叠浴缸',
      preference: '',
      versionsPerImage: 1,
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
  act(() => root.render(<BgSwapGallery />))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonLabelled(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function chooseNothing() {
  useBgSwapStore.setState((state) => ({
    draft: {
      ...state.draft,
      images: state.draft.images.map(({ chosenVersionId: _dropped, ...image }) => image),
    },
  }))
}

describe('the results overview', () => {
  it('reruns a failed version in place', () => {
    render()
    const failed = [...document.querySelectorAll('[data-bgswap-gallery-item]')].find((item) =>
      item.textContent?.includes('失败'),
    )
    if (!failed) throw new Error('no failed version card')
    click(buttonLabelled('重跑', failed))

    expect(retryVersion).toHaveBeenCalledWith('v2')
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

  it('blocks the package with a reason when the scope holds nothing', () => {
    chooseNothing()
    render()

    click(buttonLabelled('选用版'))

    const packButton = buttonLabelled('打包下载 0 张')
    expect(packButton.disabled).toBe(true)
    expect(document.body.textContent).toContain('未选用版本')
  })
})
