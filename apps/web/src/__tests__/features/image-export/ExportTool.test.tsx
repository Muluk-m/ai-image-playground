// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExportTool from '../../../features/image-export/ExportTool'
import { prepareExports } from '../../../features/image-export/export'
import { downloadImages } from '../../../features/toolbox/lib/deliver'
import { useToolboxStore } from '../../../features/toolbox/store'

vi.mock('../../../features/toolbox/lib/deliver', () => ({
  downloadImages: vi.fn(async () => {}),
  sendImagesToComposer: vi.fn(async () => {}),
}))
vi.mock('../../../features/image-export/export', async (importActual) => ({
  ...(await importActual<typeof import('../../../features/image-export/export')>()),
  prepareExports: vi.fn(async () => [{ name: 'photo.png', blob: new Blob(['out']) }]),
}))

const LONG_NAME = 'Simulator Screenshot - iPhone 17 Pro - 2026-04-09 at 20.07.12.png'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useToolboxStore.setState({ items: [], activeTool: 'export' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useToolboxStore.setState({ items: [], activeTool: null })
  vi.clearAllMocks()
})

function findButton(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(label),
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

describe('ExportTool workbench redesign', () => {
  it('disables controls and download action when no images are imported', async () => {
    await act(async () => root.render(<ExportTool />))
    expect(host.querySelector('fieldset')?.hasAttribute('disabled')).toBe(true)
    expect(findButton('下载').disabled).toBe(true)
  })

  it('shows live output dimensions on stage cards without duplicating the file list in the inspector', async () => {
    useToolboxStore.setState({
      items: [
        {
          id: 'img-1',
          name: LONG_NAME,
          url: 'blob:img-1',
          type: 'image/png',
          size: 420_000,
          width: 1206,
          height: 2622,
          decodable: true,
        },
      ],
    })
    await act(async () => root.render(<ExportTool />))

    // Filename appears once (on the stage card), never duplicated in the right inspector.
    const occurrences = host.textContent?.split(LONG_NAME).length ?? 0
    expect(occurrences - 1).toBe(1)
    expect(host.querySelector('fieldset')?.className).toContain('min-w-0')
    expect(host.innerHTML).toContain('minmax(min(196px,100%),1fr)')
    expect(host.textContent).toContain('1206 × 2622 px')

    // Scaling to 50% immediately reflects the resized output on the stage card and stats box.
    const half = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '50%',
    )!
    await act(async () => half.click())
    expect(host.textContent).toContain('603 × 1311 px')

    // Adding a second spec updates card badges and bottom export count.
    await act(async () => findButton('添加规格').click())
    expect(host.textContent).toContain('603×1311')
    expect(host.textContent).toContain('1206×2622')
    expect(findButton('导出 2 个文件')).toBeDefined()

    // Bottom export action runs cleanly.
    await act(async () => findButton('导出 2 个文件').click())
    expect(downloadImages).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight export when the imported image list changes mid-export', async () => {
    let capturedSignal: AbortSignal | undefined
    let release!: () => void
    vi.mocked(prepareExports).mockImplementationOnce(
      (_inputs, _settings, signal) =>
        new Promise((resolve) => {
          capturedSignal = signal
          release = () => resolve([{ name: 'photo.png', blob: new Blob(['out']) }])
        }),
    )
    const first = {
      id: 'img-1',
      name: 'photo.png',
      url: 'blob:img-1',
      type: 'image/png',
      size: 1000,
      width: 800,
      height: 600,
      decodable: true,
    }
    useToolboxStore.setState({ items: [first] })
    await act(async () => root.render(<ExportTool />))
    await act(async () => {
      findButton('导出 1 个文件').click()
      await Promise.resolve()
    })
    expect(capturedSignal?.aborted).toBe(false)
    await act(async () => {
      useToolboxStore.setState({ items: [first, { ...first, id: 'img-2', name: 'second.png' }] })
    })
    expect(capturedSignal?.aborted).toBe(true)
    release()
    await act(async () => {
      await Promise.resolve()
    })
    expect(downloadImages).not.toHaveBeenCalled()
  })
})
