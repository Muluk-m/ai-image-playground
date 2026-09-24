// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanvasImageMenu from '../../../../features/canvas/components/CanvasImageMenu'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useStore } from '../../../../store'

const copyBlobToClipboard = vi.fn(async (_blob: Blob) => {})
const downloadBlob = vi.fn((_blob: Blob, _name: string) => {})
vi.mock('../../../../lib/clipboard', () => ({
  copyBlobToClipboard: (blob: Blob) => copyBlobToClipboard(blob),
  getClipboardFailureMessage: (fallback: string) => fallback,
}))
vi.mock('../../../../lib/downloadImages', () => ({
  downloadBlob: (blob: Blob, name: string) => downloadBlob(blob, name),
}))

// 1×1 PNG
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc

function render(menu: { id: string; x: number; y: number } | null, onClose = () => {}): void {
  act(() => {
    root.render(<CanvasImageMenu menu={menu} doc={doc} onClose={onClose} />)
  })
}

function item(label: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.endsWith(label))!
}

beforeEach(() => {
  doc = new CanvasDoc()
  doc.restore(
    [{ id: 'img-1', type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId: 'f1' }],
    { f1: PIXEL },
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('画布图片右键菜单', () => {
  it('复制的是画布存档里的原始位图，不是屏幕上的图层', async () => {
    const onClose = vi.fn()
    render({ id: 'img-1', x: 10, y: 10 }, onClose)
    await act(async () => {
      item('复制图片').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(copyBlobToClipboard).toHaveBeenCalledTimes(1))
    const blob = copyBlobToClipboard.mock.calls[0]![0]
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBeGreaterThan(0)
    expect(onClose).toHaveBeenCalled()
    expect(useStore.getState().toast?.message).toBe('图片已复制')
  })

  it('下载用原始位图并按格式起扩展名', async () => {
    render({ id: 'img-1', x: 10, y: 10 })
    await act(async () => {
      item('下载图片').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect(downloadBlob.mock.calls[0]![1]).toBe('canvas-img-1.png')
  })

  it('opens the original image in a touch-saveable preview without importing it', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }))
    render({ id: 'img-1', x: 10, y: 10 })
    await act(async () => {
      item('查看原图 / 长按保存').click()
      await Promise.resolve()
    })
    const image = document.querySelector<HTMLImageElement>(
      '[data-lightbox-root] img.saveable-image',
    )
    expect(image?.src).toBe(PIXEL)
    expect(document.querySelector('[data-save-image]')).not.toBeNull()
  })

  it('用鼠标的设备只写「查看原图」，不提长按保存', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    render({ id: 'img-1', x: 10, y: 10 })
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels.some((text) => text?.endsWith('查看原图'))).toBe(true)
    expect(labels.some((text) => text?.includes('长按'))).toBe(false)
    expect(item('查看原图').querySelector('.lucide-eye')).not.toBeNull()
  })

  it('指着的不是图片就没有菜单', () => {
    render({ id: 'nope', x: 0, y: 0 })
    expect(document.querySelector('button')).toBeNull()
  })
})
