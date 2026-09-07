// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../features/library/store'
import { usePasteImageFiles } from '../../hooks/usePasteImageFiles'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const image = () => new File(['x'], '图.png', { type: 'image/png' })
const paper = () => new File(['x'], '说明.pdf', { type: 'application/pdf' })

function clipboardItem(file: File) {
  return { kind: 'file', type: file.type, getAsFile: () => file }
}

function pasteEvent(files: File[], strings: string[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: [
        ...strings.map((type) => ({ kind: 'string', type, getAsFile: () => null })),
        ...files.map(clipboardItem),
      ],
    },
  })
  return event
}

const browse = vi.fn()
const product = vi.fn()
const library = vi.fn()

function Consumers() {
  usePasteImageFiles('browse', browse)
  usePasteImageFiles('product', product)
  usePasteImageFiles('library', library)
  return null
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({ appMode: 'browse', showToast: vi.fn() })
  useLibraryStore.setState({ panelOpen: false, tab: 'assets' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Consumers />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

function paste(files: File[], strings: string[] = []) {
  act(() => {
    document.dispatchEvent(pasteEvent(files, strings))
  })
}

describe('routing a pasted image to one place at a time', () => {
  it('hands the image to the workbench while the workbench is in front', () => {
    paste([image()])

    expect(browse).toHaveBeenCalledTimes(1)
    expect(product).not.toHaveBeenCalled()
    expect(library).not.toHaveBeenCalled()
  })

  it('hands the image to the product shots mode instead while it is in front', () => {
    act(() => {
      useStore.setState({ appMode: 'product' })
    })

    paste([image()])

    expect(product).toHaveBeenCalledTimes(1)
    expect(browse).not.toHaveBeenCalled()
  })

  it('lets the asset panel take over from whatever mode is behind it', () => {
    act(() => {
      useStore.setState({ appMode: 'product' })
      useLibraryStore.setState({ panelOpen: true, tab: 'assets' })
    })

    paste([image()])

    expect(library).toHaveBeenCalledTimes(1)
    expect(product).not.toHaveBeenCalled()
    expect(browse).not.toHaveBeenCalled()
  })

  it('leaves the mode behind in charge while the panel shows templates', () => {
    act(() => {
      useLibraryStore.setState({ panelOpen: true, tab: 'templates' })
    })

    paste([image()])

    expect(browse).toHaveBeenCalledTimes(1)
    expect(library).not.toHaveBeenCalled()
  })
})

describe('what the clipboard is allowed to carry', () => {
  it('keeps only the images out of a mixed paste', () => {
    const png = image()

    paste([png, paper()])

    expect(browse).toHaveBeenCalledWith([png])
    expect(useStore.getState().showToast).toHaveBeenCalledWith('只支持图片文件', 'error')
  })

  it('refuses a file-only paste that carries no image', () => {
    paste([paper()])

    expect(browse).not.toHaveBeenCalled()
    expect(useStore.getState().showToast).toHaveBeenCalledWith('只支持图片文件', 'error')
  })

  it('stays out of the way of pasted text', () => {
    paste([], ['text/plain'])

    expect(browse).not.toHaveBeenCalled()
    expect(useStore.getState().showToast).not.toHaveBeenCalled()
  })
})
