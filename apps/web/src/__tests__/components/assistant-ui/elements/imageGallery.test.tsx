// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageGallery } from '../../../../components/assistant-ui/elements/image-gallery'

const items = ['one', 'two', 'three'].map((id) => ({ id, source: `preview:${id}` }))
let host: HTMLDivElement
let root: Root
const open = vi.fn()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  open.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function GalleryHarness({ current, visible }: { current: typeof items; visible: boolean }) {
  const [selectedId, setSelectedId] = useState<string>()
  return visible ? (
    <ImageGallery
      items={current}
      selectedId={selectedId}
      onSelect={(item) => setSelectedId(item.id)}
      itemLabel={(index) => `Image ${index + 1}`}
      renderItem={(item) => (
        <button type="button" data-current={item.id} onClick={() => open(item.id)}>
          Open {item.id}
        </button>
      )}
    />
  ) : null
}
function render(current = items, visible = true) {
  act(() => root.render(<GalleryHarness current={current} visible={visible} />))
}
function tile(id: string) {
  return host.querySelector<HTMLButtonElement>(`[data-current="${id}"]`)!
}
function selected() {
  return host.querySelector('[data-selected] [data-current]')!.getAttribute('data-current')
}
it('shows every artifact and opens each directly while preserving keyboard navigation', () => {
  render()
  expect(host.querySelectorAll('[data-current]')).toHaveLength(3)
  act(() => tile('two').click())
  expect(open).toHaveBeenCalledWith('two')
  expect(selected()).toBe('two')
  act(() =>
    tile('two').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  )
  expect(selected()).toBe('three')
  expect(document.activeElement).toBe(tile('three'))
  act(() =>
    tile('three').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  )
  expect(selected()).toBe('three')
  act(() =>
    tile('three').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
  )
  expect(selected()).toBe('two')
})
it('keeps selection by artifact id when items reorder and falls back when removed', () => {
  render()
  act(() => tile('two').click())
  render([items[1], items[0], items[2]])
  expect(selected()).toBe('two')
  render([items[0], items[2]])
  expect(selected()).toBe('one')
})
it('handles one item and an empty group', () => {
  render([items[0]])
  expect(host.querySelectorAll('button')).toHaveLength(1)
  render([])
  expect(host.childElementCount).toBe(0)
})
it('keeps the controlled selection when the gallery unmounts temporarily', () => {
  render()
  act(() => tile('two').click())
  render(items, false)
  expect(host.childElementCount).toBe(0)
  render(items, true)
  expect(selected()).toBe('two')
})
