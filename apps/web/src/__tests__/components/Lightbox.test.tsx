// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Lightbox from '../../components/Lightbox'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const IMAGE_SRC = 'data:image/png;base64,iVBORw0KGgo='

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }))

vi.mock('../../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store')>()
  return {
    ...actual,
    getCachedImage: () => IMAGE_SRC,
    ensureImageCached: async () => IMAGE_SRC,
  }
})

vi.mock('../../lib/downloadImages', () => ({ downloadBlob }))

let host: HTMLDivElement
let root: Root

function stubPointer(kind: 'coarse' | 'fine') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes(kind),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  downloadBlob.mockClear()
  stubPointer('fine')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'image/png' }) })),
  )
  useStore.setState({
    lightboxImageId: 'img-1',
    lightboxImageList: ['img-1'],
    tasks: [],
    maskDraft: null,
    showToast: vi.fn(),
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
})

function renderLightbox() {
  act(() => root.render(<Lightbox />))
}

function lightboxRoot(): HTMLDivElement {
  const el = document.body.querySelector<HTMLDivElement>('[data-lightbox-root]')
  if (!el) throw new Error('lightbox not rendered')
  return el
}

function lightboxImage(): HTMLImageElement {
  const img = lightboxRoot().querySelector<HTMLImageElement>('img[data-image-id]')
  if (!img) throw new Error('lightbox image not rendered')
  return img
}

/** 派发一次触控事件，返回它是否被 preventDefault */
function fireTouch(
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: Array<{ x: number; y: number }>,
): boolean {
  const touches = points.map((p) => ({ clientX: p.x, clientY: p.y, target }) as unknown as Touch)
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
    targetTouches: touches,
    changedTouches: touches,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event.defaultPrevented
}

/** 双击放大到 300%，触发旧代码里拦截 touchstart 的那条分支 */
function zoomInByDoubleTap(image: HTMLImageElement) {
  fireTouch(image, 'touchstart', [{ x: 100, y: 100 }])
  fireTouch(image, 'touchend', [])
  fireTouch(image, 'touchstart', [{ x: 100, y: 100 }])
  fireTouch(image, 'touchend', [])
  expect(image.parentElement?.style.transform).toContain('scale(3)')
}

describe('Lightbox 触控手势', () => {
  it('放大后单指静止触摸不被取消，长按保存菜单仍能弹出', () => {
    renderLightbox()
    const image = lightboxImage()
    zoomInByDoubleTap(image)

    expect(fireTouch(image, 'touchstart', [{ x: 100, y: 100 }])).toBe(false)
  })

  it('双指捏合仍被取消', () => {
    renderLightbox()
    const image = lightboxImage()

    expect(
      fireTouch(image, 'touchstart', [
        { x: 80, y: 100 },
        { x: 180, y: 100 },
      ]),
    ).toBe(true)
  })

  it('单指移动超过阈值后才拦截并开始拖动', () => {
    renderLightbox()
    const image = lightboxImage()
    zoomInByDoubleTap(image)

    fireTouch(image, 'touchstart', [{ x: 100, y: 100 }])
    // 长按时手指的轻微抖动不算拖动
    expect(fireTouch(image, 'touchmove', [{ x: 102, y: 101 }])).toBe(false)
    const before = image.parentElement?.style.transform

    expect(fireTouch(image, 'touchmove', [{ x: 160, y: 100 }])).toBe(true)
    expect(image.parentElement?.style.transform).not.toBe(before)
  })

  it('系统长按菜单打断触摸（touchcancel）后不残留拖动状态', () => {
    renderLightbox()
    const image = lightboxImage()
    zoomInByDoubleTap(image)

    fireTouch(image, 'touchstart', [{ x: 100, y: 100 }])
    fireTouch(image, 'touchcancel', [])
    const before = image.parentElement?.style.transform

    expect(fireTouch(image, 'touchmove', [{ x: 200, y: 100 }])).toBe(false)
    expect(image.parentElement?.style.transform).toBe(before)
  })
})

describe('Lightbox 图片元素', () => {
  it('可命中且按 saveable-image 放行长按菜单与选择', () => {
    renderLightbox()
    const image = lightboxImage()

    expect(image.className).toContain('saveable-image')
    expect(image.className).not.toContain('pointer-events-none')

    // jsdom 不加载样式表，故直接查 .saveable-image 这条规则本身
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const rule = css.match(/\.saveable-image\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('-webkit-touch-callout: default')
    expect(rule).toContain('user-select: auto')
  })
})

describe('Lightbox 保存按钮', () => {
  function saveButton(): HTMLButtonElement | null {
    return lightboxRoot().querySelector<HTMLButtonElement>('button[data-save-image]')
  }

  it('只在粗指针设备上出现', () => {
    renderLightbox()
    expect(saveButton()).toBeNull()

    act(() => root.unmount())
    stubPointer('coarse')
    root = createRoot(host)
    renderLightbox()
    expect(saveButton()?.textContent).toContain('保存图片')
  })

  it('点击后走下载路径', async () => {
    stubPointer('coarse')
    renderLightbox()

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(downloadBlob).toHaveBeenCalledTimes(1)
    expect(useStore.getState().lightboxImageId).toBe('img-1')
  })
})
