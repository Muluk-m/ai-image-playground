// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord } from '../../../../features/library/types'
import RemixMode from '../../../../features/remix/components/RemixMode'
import { useRemixStore } from '../../../../features/remix/store'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASSET: AssetRecord = {
  id: 'a1',
  name: '白色蛋形浴缸',
  imageId: 'image-a',
  createdAt: 1,
  lastUsedAt: 1,
}

const PRODUCT = {
  name: 'W2753 浴缸',
  features: '蛋形单边斜背',
  mainColor: '哑光灰棕',
  forbiddenColors: ['米白'],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), setConfirmDialog: vi.fn() })
  useLibraryStore.setState({ assets: [ASSET], loadAssets: vi.fn().mockResolvedValue(undefined) })
  useRemixStore.getState().startNewSet()
  useRemixStore.setState({ sets: [], loadSets: vi.fn().mockResolvedValue(undefined) })
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
  act(() => root.render(<RemixMode />))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function findByText(text: string): HTMLElement {
  const element = [...document.querySelectorAll('button, h2, h3, label, p, span')].find(
    (node) => node.textContent === text,
  )
  if (!element) throw new Error(`no element with text ${text}`)
  return element as HTMLElement
}

describe('the remix wizard', () => {
  it('shows the three steps with the input step open', () => {
    render()

    expect(document.body.textContent).toContain('① 输入')
    expect(document.body.textContent).toContain('② 简报与镜头')
    expect(document.body.textContent).toContain('③ 生成')
    expect(findByText('抓取图集')).toBeTruthy()
    expect(findByText('保存并下一步')).toBeTruthy()
  })

  it('explains the fallback when the listing cannot be fetched', () => {
    const fetchListing = vi.fn(async () => {
      useRemixStore.setState({ listingNotice: '链接抓取未开启，请直接上传竞品图' })
    })
    useRemixStore.setState({ fetchListing })
    render()

    click(findByText('抓取图集'))
    act(() => {})

    expect(fetchListing).toHaveBeenCalled()
    expect(document.body.textContent).toContain('请直接上传竞品图')
  })

  it('asks for a front shot until one of the picked assets is labelled front', () => {
    render()

    click(findByText(ASSET.name))
    expect(document.body.textContent).toContain('建议补一张正面白底图')

    const angle = document.querySelector<HTMLSelectElement>('select[data-angle-for="a1"]')
    if (!angle) throw new Error('no angle select')
    act(() => {
      angle.value = 'front'
      angle.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(useRemixStore.getState().draft.productAssets).toEqual([
      { assetId: 'a1', angle: 'front' },
    ])
    expect(document.body.textContent).not.toContain('建议补一张正面白底图')
  })

  it('drops a competitor image from the thumbnail strip', () => {
    useRemixStore.getState().addSourceImages(['i1', 'i2'])
    render()

    const remove = document.querySelector('[aria-label="移除竞品图 1"]')
    if (!remove) throw new Error('no remove button')
    click(remove)

    expect(useRemixStore.getState().draft.sourceImageIds).toEqual(['i2'])
  })

  it('lists the saved sets so one can be reopened', () => {
    useRemixStore.setState({
      sets: [
        {
          id: 'set1',
          name: '奶油浴缸',
          source: { kind: 'competitor', sourceImageIds: ['i1'] },
          productAssets: [],
          settings: { platform: 'amazon', language: 'zh', level: 'high', product: PRODUCT },
          shots: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    render()

    click(findByText('奶油浴缸'))

    expect(useRemixStore.getState().activeSetId).toBe('set1')
    expect(useRemixStore.getState().draft.sourceImageIds).toEqual(['i1'])
  })
})
