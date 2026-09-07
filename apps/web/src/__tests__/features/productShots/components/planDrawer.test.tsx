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
      {
        id: 'asset-1',
        name: '正面白底',
        imageId: 'product-1',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      },
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

function inventoryBox() {
  return document.body.querySelector<HTMLElement>('[data-product-shots-plan-inventory]')
}

function chipNames() {
  const chips = inventoryBox()?.querySelectorAll('[data-product-shots-plan-chip]') ?? []
  return [...chips].map((chip) => chip.getAttribute('data-product-shots-plan-chip'))
}

function inventoryInput() {
  const input = inventoryBox()?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error('no inventory input')
  return input
}

function storedVersion() {
  return useProductShotsStore.getState().draft.images[0].versions[0]
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function removeChip(name: string) {
  const button = inventoryBox()?.querySelector(`button[aria-label="删除 ${name}"]`)
  if (!button) throw new Error(`no chip named ${name}`)
  click(button)
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PlanDrawer 产品清单', () => {
  it('把只换背景那一版的清单排成 chip', () => {
    render(version({ inventory: ['浴缸', '落地龙头'] }))

    expect(chipNames()).toEqual(['浴缸', '落地龙头'])
  })

  it('换产品并换背景也摆出清单', () => {
    render(version({ mode: 'replace-and-background', inventory: ['台灯', '电源线'] }))

    expect(chipNames()).toEqual(['台灯', '电源线'])
  })

  it('换产品那一版不摆清单', () => {
    render(version({ mode: 'replace-product', inventory: ['浴缸'] }))

    expect(inventoryBox()).toBeNull()
  })

  it('旧记录没有清单时只留一个空输入框', () => {
    render(version())

    expect(inventoryBox()).not.toBeNull()
    expect(chipNames()).toEqual([])
    expect(inventoryInput().value).toBe('')
  })

  it('删掉一个 chip 后就地重算提示词', () => {
    render(version({ inventory: ['浴缸', '落地龙头'] }))

    removeChip('落地龙头')

    expect(chipNames()).toEqual(['浴缸'])
    expect(storedVersion().inventory).toEqual(['浴缸'])
    expect(storedVersion().prompt).toContain('不动的部分：浴缸。')
  })

  it('删光之后清单落成空列表', () => {
    render(version({ inventory: ['浴缸'] }))

    removeChip('浴缸')

    expect(chipNames()).toEqual([])
    expect(storedVersion().inventory).toEqual([])
  })

  it('回车把输入框里的名字加进清单', () => {
    render(version({ inventory: ['浴缸'] }))

    const input = inventoryInput()
    type(input, ' 落地龙头 ')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(chipNames()).toEqual(['浴缸', '落地龙头'])
    expect(storedVersion().inventory).toEqual(['浴缸', '落地龙头'])
    expect(inventoryInput().value).toBe('')
  })

  it('手改过的提示词不被清单改动覆盖', () => {
    render(version({ inventory: ['浴缸', '落地龙头'] }))

    const prompt = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="提示词"]')
    if (!prompt) throw new Error('no prompt field')
    type(prompt, '我自己写的提示词')

    removeChip('落地龙头')

    expect(storedVersion().inventory).toEqual(['浴缸'])
    expect(storedVersion().prompt).toBe('我自己写的提示词')
  })
})
