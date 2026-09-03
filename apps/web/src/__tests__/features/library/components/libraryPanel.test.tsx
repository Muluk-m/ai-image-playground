// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryPanel from '../../../../features/library/components/LibraryPanel'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord } from '../../../../features/library/types'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASSET: AssetRecord = {
  id: 'a1',
  name: '白底图',
  imageId: 'image-a',
  createdAt: 1,
  lastUsedAt: 1,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), setConfirmDialog: vi.fn(), setLightboxImageId: vi.fn() })
  useLibraryStore.setState({
    panelOpen: true,
    tab: 'assets',
    searchKeyword: '',
    assets: [ASSET],
    templates: [],
    detailTemplateId: null,
    pendingAssetNames: [],
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(<LibraryPanel />))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

describe('the new asset entry', () => {
  it('opens the file picker and hands the chosen images to the library', () => {
    const importAssetFiles = vi.fn().mockResolvedValue(undefined)
    useLibraryStore.setState({ importAssetFiles })
    render()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('no file input')
    const openPicker = vi.spyOn(input, 'click')

    click(findButton('新建素材'))
    expect(openPicker).toHaveBeenCalled()

    const file = new File(['x'], '白底图.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(importAssetFiles).toHaveBeenCalledWith([file])
  })

  it('takes multiple files at once', () => {
    render()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')

    expect(input?.multiple).toBe(true)
    expect(input?.accept).toBe('image/*')
  })

  it('stays out of the templates tab', () => {
    useLibraryStore.setState({ tab: 'templates' })
    render()

    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})

describe('the asset card', () => {
  it('always shows what a click does, without waiting for a hover', () => {
    render()

    expect(document.body.textContent).toContain('加入参考图')
  })

  it('opens the image in the lightbox', () => {
    render()

    click(document.querySelector('[aria-label="放大预览"]') as Element)

    expect(useStore.getState().setLightboxImageId).toHaveBeenCalledWith('image-a')
  })
})

describe('the empty asset tab', () => {
  beforeEach(() => {
    useLibraryStore.setState({ assets: [] })
  })

  it('shows how an asset is made, with an illustration', () => {
    render()

    expect(document.body.textContent).toContain('右键参考图缩略图，选择存为素材')
    expect(document.querySelector('[data-empty-illustration]')).not.toBeNull()
  })

  it('offers the import entry inside the empty state', () => {
    const input = () => document.querySelector<HTMLInputElement>('input[type="file"]')
    render()
    const openPicker = vi.spyOn(input() as HTMLInputElement, 'click')

    const buttons = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent === '新建素材',
    )
    click(buttons[buttons.length - 1])

    expect(openPicker).toHaveBeenCalled()
  })

  it('keeps the plain no-match line when a search hides every asset', () => {
    useLibraryStore.setState({ assets: [ASSET], searchKeyword: '不存在' })
    render()

    expect(document.body.textContent).toContain('没有匹配的素材')
    expect(document.body.textContent).not.toContain('右键参考图缩略图')
  })
})

describe('the empty template tab', () => {
  beforeEach(() => {
    useLibraryStore.setState({ tab: 'templates', templates: [] })
  })

  it('shows how a template is made and called', () => {
    render()

    expect(document.body.textContent).toContain('写好提示词后点存为模板，输入 / 调用')
  })
})
