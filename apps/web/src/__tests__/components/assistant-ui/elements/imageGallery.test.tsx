// @vitest-environment jsdom
import { act } from 'react'
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
function render(current = items) {
  act(() =>
    root.render(
      <ImageGallery
        items={current}
        previousLabel="Previous"
        nextLabel="Next"
        itemLabel={(index) => `Image ${index + 1}`}
        renderItem={(item) => (
          <button type="button" data-current={item.id} onClick={() => open(item.id)}>
            Open {item.id}
          </button>
        )}
      />,
    ),
  )
}
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}
function current() {
  return host.querySelector<HTMLButtonElement>('[data-current]')!
}
it('browses with arrows and thumbnails and opens the selected artifact', () => {
  render()
  expect(button('Previous').disabled).toBe(true)
  act(() => button('Next').click())
  expect(current().dataset.current).toBe('two')
  expect(button('Image 2').getAttribute('aria-pressed')).toBe('true')
  act(() => current().click())
  expect(open).toHaveBeenCalledWith('two')
  act(() => button('Image 3').click())
  expect(current().dataset.current).toBe('three')
  expect(button('Next').disabled).toBe(true)
  act(() =>
    current().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
  )
  expect(current().dataset.current).toBe('two')
  act(() => button('Previous').click())
  expect(current().dataset.current).toBe('one')
})
it('keeps selection by artifact id when items reorder and falls back when removed', () => {
  render()
  act(() => button('Image 2').click())
  render([items[1], items[0], items[2]])
  expect(current().dataset.current).toBe('two')
  expect(button('Image 1').getAttribute('aria-pressed')).toBe('true')
  render([items[0], items[2]])
  expect(current().dataset.current).toBe('one')
})
it('hides navigation for one item and handles an empty group', () => {
  render([items[0]])
  expect(host.querySelectorAll('button')).toHaveLength(1)
  render([])
  expect(host.childElementCount).toBe(0)
})
