// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NodeAssetsPanel from '../../../../features/canvas/components/NodeAssetsPanel'
import type { CanvasAssetItem } from '../../../../features/canvas/lib/canvasAssets'

const assets = vi.hoisted(() => ({
  items: [] as CanvasAssetItem[],
  scopes: [] as string[],
}))
vi.mock('../../../../features/canvas/lib/useCanvasAssets', () => ({
  useCanvasAssets: (_conversationId: string | null, scope: string) => {
    assets.scopes.push(scope)
    return { items: assets.items, loading: false, failed: false, hasMore: false, loadMore() {} }
  },
}))

function asset(id: string, media: 'image' | 'video', createdAt = Date.now()): CanvasAssetItem {
  return {
    id,
    title: `作品 ${id}`,
    media,
    format: media === 'video' ? 'MP4' : 'PNG',
    createdAt,
    conversationId: 'c1',
    load: async () => null,
    insert: { kind: media, source: { type: 'media', mediaId: id } },
    download: { name: id, fetch: async () => null },
  }
}

let root: Root
let host: HTMLDivElement

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button')]
}
function byText(text: string): HTMLButtonElement {
  const found = buttons().find((one) => one.textContent?.trim() === text)
  if (!found) throw new Error(`No button: ${text}`)
  return found
}
function byLabel(label: string): HTMLButtonElement {
  const found = buttons().find((one) => one.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button: ${label}`)
  return found
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

function render(props: Partial<Parameters<typeof NodeAssetsPanel>[0]> = {}) {
  const onPlace = vi.fn(async () => true)
  const onDownload = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <NodeAssetsPanel
        conversationId="c1"
        onClose={onClose}
        onPlace={onPlace}
        onDownload={onDownload}
        {...props}
      />,
    )
  })
  return { onPlace, onDownload, onClose }
}

describe('NodeAssetsPanel', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    assets.items = [
      asset('a', 'image'),
      asset('b', 'image', Date.now() - 86_400_000),
      asset('v', 'video'),
    ]
    assets.scopes = []
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows image and video counts, grouped by day, current project by default', async () => {
    render()
    expect(byText('图片 (2)').getAttribute('aria-selected')).toBe('true')
    expect(byText('视频 (1)').getAttribute('aria-selected')).toBe('false')
    expect([...host.querySelectorAll('.studio-assets-day')].map((p) => p.textContent)).toEqual([
      '今天',
      '昨天',
    ])
    expect(host.querySelectorAll('.studio-assets-card')).toHaveLength(2)
    expect(assets.scopes.every((scope) => scope === 'project')).toBe(true)
    await click(byText('视频 (1)'))
    expect(host.querySelectorAll('.studio-assets-card')).toHaveLength(1)
    expect(host.querySelector('.studio-assets-pill')?.textContent).toBe('视频')
  })

  it('places a clicked item and stays open', async () => {
    const { onPlace, onClose } = render()
    await click(byLabel('作品 a'))
    expect(onPlace).toHaveBeenCalledWith([assets.items[0]])
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('.studio-assets-panel')).not.toBeNull()
  })

  it('selects several items, downloads them and applies them, then leaves select mode', async () => {
    const { onPlace, onDownload } = render()
    await click(byText('选择'))
    expect(host.textContent).toContain('已选 0 项')
    await click(byLabel('作品 a'))
    await click(byLabel('作品 b'))
    expect(onPlace).not.toHaveBeenCalled()
    expect(byLabel('作品 a').getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('已选 2 项')
    await click(byText('下载'))
    expect(onDownload).toHaveBeenCalledWith([assets.items[0], assets.items[1]])
    await click(byText('应用到画布'))
    expect(onPlace).toHaveBeenCalledWith([assets.items[0], assets.items[1]])
    expect(host.querySelector('.studio-assets-bar')).toBeNull()
    expect(byText('选择')).toBeTruthy()
  })

  it('keeps the selection when placing fails', async () => {
    render({ onPlace: vi.fn(async () => false) })
    await click(byText('选择'))
    await click(byLabel('作品 a'))
    await click(byText('应用到画布'))
    expect(host.textContent).toContain('已选 1 项')
  })

  it('expands to show the project scope switch and lists formats in list view', async () => {
    render()
    expect(host.textContent).not.toContain('所有项目')
    await click(byLabel('展开'))
    expect(host.querySelector('.studio-assets-panel')?.getAttribute('data-wide')).toBe('true')
    expect(byText('当前项目').getAttribute('aria-selected')).toBe('true')
    await click(byText('所有项目'))
    expect(assets.scopes[assets.scopes.length - 1]).toBe('all')
    await click(byLabel('列表视图'))
    expect([...host.querySelectorAll('.studio-assets-format')].map((s) => s.textContent)).toEqual([
      'PNG',
      'PNG',
    ])
  })
})
