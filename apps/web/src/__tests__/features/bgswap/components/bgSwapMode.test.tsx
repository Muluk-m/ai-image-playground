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

vi.mock('../../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  storeImageFromFile,
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useBgSwapStore.setState({ jobs: [], loadJobs: vi.fn().mockResolvedValue(undefined) })
  useBgSwapStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
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

  it('holds the background swap button until the ticket that runs it lands', () => {
    render()

    const swap = [...column('controls').querySelectorAll('button')].find(
      (button) => button.textContent === '换背景',
    )
    expect(swap?.disabled).toBe(true)
  })
})
