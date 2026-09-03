// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TemplateCard from '../../../../features/library/components/TemplateCard'
import TemplateDetail from '../../../../features/library/components/TemplateDetail'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord, TemplateRecord } from '../../../../features/library/types'
import { getSelectedImageMentionLabel } from '../../../../lib/promptImageMentions'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mention = getSelectedImageMentionLabel

function makeAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return { id: 'a1', name: '白底图', imageId: 'image-a', createdAt: 1, lastUsedAt: 1, ...overrides }
}

function makeTemplate(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: 't1',
    name: '锁产品前缀',
    prompt: '前缀',
    assetIds: [],
    params: { size: 'auto', quality: 'auto', n: 1 },
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), setConfirmDialog: vi.fn() })
  useLibraryStore.setState({ assets: [], templates: [], detailTemplateId: null, panelOpen: true })
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

function render(element: React.ReactElement) {
  act(() => root.render(element))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the template card', () => {
  it('shows one thumbnail per referenced asset', () => {
    const assets = [makeAsset(), makeAsset({ id: 'a2', name: '场景图', imageId: 'image-b' })]
    render(<TemplateCard template={makeTemplate({ assetIds: ['a1', 'a2'] })} />)

    useLibraryStore.setState({ assets })
    render(<TemplateCard template={makeTemplate({ assetIds: ['a1', 'a2'] })} />)

    expect(host.querySelectorAll('li')).toHaveLength(2)
  })

  it('caps the strip at four and counts the rest', () => {
    const assetIds = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
    useLibraryStore.setState({
      assets: assetIds.map((id) => makeAsset({ id, imageId: `image-${id}` })),
    })

    render(<TemplateCard template={makeTemplate({ assetIds })} />)

    expect(host.querySelectorAll('li')).toHaveLength(4)
    expect(host.textContent).toContain('+2')
  })

  it('keeps a placeholder for an asset that was deleted', () => {
    useLibraryStore.setState({ assets: [] })

    render(<TemplateCard template={makeTemplate({ assetIds: ['gone'] })} />)

    expect(host.querySelector('li')?.textContent).toBe('')
    expect(host.querySelector('li [title]')?.getAttribute('title')).toBe('素材已删除')
  })

  it('labels every param', () => {
    render(<TemplateCard template={makeTemplate()} />)

    expect(host.textContent).toContain('尺寸 auto')
    expect(host.textContent).toContain('质量 auto')
    expect(host.textContent).toContain('数量 1 张')
  })

  it('opens the detail when the card is clicked', () => {
    const template = makeTemplate()
    useLibraryStore.setState({ templates: [template] })
    render(<TemplateCard template={template} />)

    const opener = host.querySelector('[role="button"]')
    if (!opener) throw new Error('card body is not clickable')
    click(opener)

    expect(useLibraryStore.getState().detailTemplateId).toBe('t1')
  })
})

describe('the template detail', () => {
  function renderDetail(template: TemplateRecord, assets: AssetRecord[] = []) {
    useLibraryStore.setState({ templates: [template], assets, detailTemplateId: template.id })
    render(<TemplateDetail />)
  }

  it('renders references and slots as chips', () => {
    renderDetail(
      makeTemplate({ prompt: `${mention(0)} 背景换成 {背景}`, assetIds: ['a1'] }),
      [makeAsset()],
    )

    expect(document.querySelector('.mention-tag:not(.slot-tag)')?.textContent).toBe('@白底图')
    expect(document.querySelector('.slot-tag')?.textContent).toBe('{背景}')
  })

  it('lists the referenced assets with their names', () => {
    renderDetail(makeTemplate({ assetIds: ['a1', 'gone'] }), [makeAsset()])

    expect(document.body.textContent).toContain('白底图')
    expect(document.body.textContent).toContain('素材已删除')
  })

  it('applies the template', () => {
    const applyTemplate = vi.fn().mockResolvedValue(undefined)
    useLibraryStore.setState({ applyTemplate })
    renderDetail(makeTemplate())

    const apply = [...document.querySelectorAll('button')].find((b) => b.textContent === '套用')
    if (!apply) throw new Error('no apply button')
    click(apply)

    expect(applyTemplate).toHaveBeenCalledWith('t1')
  })

  it('asks before deleting', () => {
    renderDetail(makeTemplate())

    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === '删除')
    if (!remove) throw new Error('no delete button')
    click(remove)

    expect(useStore.getState().setConfirmDialog).toHaveBeenCalled()
  })

  it('stays out of the way when nothing is open', () => {
    useLibraryStore.setState({ detailTemplateId: null })
    render(<TemplateDetail />)

    expect(document.body.querySelector('[data-no-drag-select]')).toBeNull()
  })
})
