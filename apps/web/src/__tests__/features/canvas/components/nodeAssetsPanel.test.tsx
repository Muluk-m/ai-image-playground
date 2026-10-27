// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NodeAssetsPanel from '../../../../features/canvas/components/NodeAssetsPanel'
import { useCanvasAssetsEntry } from '../../../../features/canvas/lib/assetsEntry'
import type { CanvasAssetItem } from '../../../../features/canvas/lib/canvasAssets'
import { useMediaTransferStore } from '../../../../features/canvas/lib/mediaTransfer'

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

// 弹窗经 Overlay portal 到 body，查询都落在 document 上。
function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.studio-canvas-assets-modal')
}
function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
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

function Harness(props: Partial<Parameters<typeof NodeAssetsPanel>[0]>) {
  const open = useCanvasAssetsEntry((s) => s.open)
  const setOpen = useCanvasAssetsEntry((s) => s.setOpen)
  return open ? (
    <NodeAssetsPanel
      conversationId="c1"
      onClose={() => setOpen(false)}
      onPlace={async () => true}
      onDownload={() => {}}
      {...props}
    />
  ) : null
}

function render(props: Partial<Parameters<typeof NodeAssetsPanel>[0]> = {}) {
  const onPlace = props.onPlace ?? vi.fn(async () => true)
  const onDownload = vi.fn()
  act(() => {
    useCanvasAssetsEntry.getState().setOpen(true)
  })
  act(() => {
    root.render(<Harness {...props} onPlace={onPlace} onDownload={onDownload} />)
  })
  return { onPlace, onDownload }
}
function reopen() {
  act(() => {
    useCanvasAssetsEntry.getState().setOpen(true)
  })
}

describe('NodeAssetsPanel', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useCanvasAssetsEntry.setState({ open: false, media: 'image', scope: 'project' })
    useMediaTransferStore.setState({ transfer: null })
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

  it('opens as a modal dialog with the search focused, both scopes shown and no list or expand', () => {
    render()
    const modal = dialog()!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(modal.getAttribute('aria-labelledby')!)?.textContent).toBe(
      '资产',
    )
    expect(document.activeElement?.getAttribute('placeholder')).toBe('搜索资产…')
    expect(byText('当前项目').getAttribute('aria-selected')).toBe('true')
    expect(byText('所有项目').getAttribute('aria-selected')).toBe('false')
    expect(
      buttons().some((one) => /展开|列表|排序/.test(one.getAttribute('aria-label') ?? '')),
    ).toBe(false)
  })

  it('shows image and video counts, grouped by day, current project by default', async () => {
    render()
    expect(byText('图片 (2)').getAttribute('aria-selected')).toBe('true')
    expect(byText('视频 (1)').getAttribute('aria-selected')).toBe('false')
    expect(
      [...document.querySelectorAll('.studio-canvas-assets-day')].map((p) => p.textContent),
    ).toEqual(['今天', '昨天'])
    expect(document.querySelectorAll('.studio-canvas-assets-card')).toHaveLength(2)
    expect(assets.scopes.every((scope) => scope === 'project')).toBe(true)
    await click(byText('视频 (1)'))
    expect(document.querySelectorAll('.studio-canvas-assets-card')).toHaveLength(1)
    expect(document.querySelector('.studio-canvas-assets-pill')?.textContent).toBe('视频')
  })

  it('places a clicked item and closes', async () => {
    const { onPlace } = render()
    await click(byLabel('作品 a'))
    expect(onPlace).toHaveBeenCalledWith([assets.items[0]])
    expect(dialog()).toBeNull()
  })

  it('downloads the selection and stays open, then applies it and closes', async () => {
    const { onPlace, onDownload } = render()
    await click(byText('选择'))
    expect(document.body.textContent).toContain('已选 0 项')
    await click(byLabel('作品 a'))
    await click(byLabel('作品 b'))
    expect(onPlace).not.toHaveBeenCalled()
    expect(byLabel('作品 a').getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('已选 2 项')
    await click(byText('下载'))
    expect(onDownload).toHaveBeenCalledWith([assets.items[0], assets.items[1]])
    expect(dialog()).not.toBeNull()
    await click(byText('应用到画布'))
    expect(onPlace).toHaveBeenCalledWith([assets.items[0], assets.items[1]])
    expect(dialog()).toBeNull()
  })

  it('keeps the selection and stays open when placing fails', async () => {
    render({ onPlace: vi.fn(async () => false) })
    await click(byText('选择'))
    await click(byLabel('作品 a'))
    await click(byText('应用到画布'))
    expect(dialog()).not.toBeNull()
    expect(document.body.textContent).toContain('已选 1 项')
  })

  it('clears the selection when switching between images and videos', async () => {
    render()
    await click(byText('选择'))
    await click(byLabel('作品 a'))
    expect(document.body.textContent).toContain('已选 1 项')
    await click(byText('视频 (1)'))
    expect(document.body.textContent).toContain('已选 0 项')
    await click(byText('图片 (2)'))
    expect(byLabel('作品 a').getAttribute('aria-checked')).toBe('false')
  })

  it('closes on Esc, X and the backdrop, resetting the selection but keeping tab and scope', async () => {
    render()
    await click(byText('视频 (1)'))
    await click(byText('所有项目'))
    expect(assets.scopes[assets.scopes.length - 1]).toBe('all')
    await click(byText('选择'))
    await click(byLabel('作品 v'))
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(dialog()).toBeNull()

    reopen()
    expect(byText('视频 (1)').getAttribute('aria-selected')).toBe('true')
    expect(byText('所有项目').getAttribute('aria-selected')).toBe('true')
    expect(byText('选择').getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('.studio-canvas-assets-bar')).toBeNull()
    await click(byLabel('关闭资产'))
    expect(dialog()).toBeNull()

    reopen()
    const surface = dialog()!.parentElement!.parentElement!
    act(() => {
      surface.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      surface.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(dialog()).toBeNull()
  })

  it('lifts the transfer card into the modal layer while it is open', () => {
    useMediaTransferStore.setState({
      transfer: { id: 1, fileName: 'x.zip', status: 'packing', progress: 0.5 },
    })
    render()
    const card = document.querySelector('.studio-transfer')!
    expect(card.hasAttribute('data-lifted')).toBe(true)
    expect(card.parentElement).toBe(dialog()!.parentElement)
  })
})
