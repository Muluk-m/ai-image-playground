// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import PlanDrawer from '../../../../features/productShots/components/PlanDrawer'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotVersion } from '../../../../features/productShots/types'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../../hooks/useImageThumbnail', () => ({
  useImageThumbnail: (imageId: string | undefined) =>
    imageId ? { dataUrl: `data:image/png;base64,${imageId}` } : null,
}))

function version(patch: Partial<ProductShotVersion> = {}): ProductShotVersion {
  return {
    id: 'v1',
    taskId: 'task-v1',
    plan: '放进有窗光的日式木质浴室',
    prompt: 'p',
    masked: true,
    mode: 'background',
    createdAt: 1,
    ...patch,
  }
}

const setLightboxImageId = vi.fn<(id: string | null, list?: string[]) => void>()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ setLightboxImageId })
  useLibraryStore.setState({
    assets: [
      { id: 'asset-1', name: '正面白底', imageId: 'product-1', createdAt: 1, lastUsedAt: 1 },
    ],
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

function render(item: ProductShotVersion) {
  useProductShotsStore.setState({
    planVersionId: item.id,
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
      images: [{ imageId: 'src-1', versions: [item] }],
    },
  })
  act(() => root.render(<PlanDrawer />))
}

function thumbs() {
  return [...document.body.querySelectorAll('[data-product-shots-plan-references] button')]
}

function imageIds() {
  return thumbs().map((button) => button.querySelector('img')?.getAttribute('data-image-id'))
}

describe('PlanDrawer 参考图', () => {
  it('只有原图时只出一张缩略图', () => {
    render(version())

    expect(thumbs().map((button) => button.getAttribute('aria-label'))).toEqual(['放大原图'])
    expect(imageIds()).toEqual(['src-1'])
  })

  it('换产品且有蒙版时出原图、产品、蒙版三张', () => {
    render(version({ productAssetId: 'asset-1', maskImageId: 'mask-1' }))

    expect(thumbs().map((button) => button.getAttribute('aria-label'))).toEqual([
      '放大原图',
      '放大产品',
      '放大蒙版',
    ])
    expect(imageIds()).toEqual(['src-1', 'product-1', 'mask-1'])
  })

  it('抠图预览优先于原始蒙版', () => {
    render(version({ maskImageId: 'mask-1', mattePreviewImageId: 'matte-1' }))

    expect(imageIds()).toEqual(['src-1', 'matte-1'])
  })

  it('点缩略图打开大图，翻页范围是这组参考图', () => {
    render(version({ productAssetId: 'asset-1' }))

    act(() => {
      thumbs()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setLightboxImageId).toHaveBeenCalledWith('product-1', ['src-1', 'product-1'])
  })

  it('有产品框时原图缩略图上画出框', () => {
    render(version({ productBox: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }))

    const box = thumbs()[0].querySelector<HTMLElement>('[data-product-shots-plan-box]')
    expect(thumbs()[0].className).toContain('relative')
    expect(box).not.toBeNull()
    expect(box?.style.left).toBe('10%')
    expect(box?.style.width).toBe('50%')
  })

  it('没有产品框时不画框', () => {
    render(version())

    expect(document.body.querySelector('[data-product-shots-plan-box]')).toBeNull()
  })
})
