// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { OverflowText, useOverflowTitle } from '../../../components/ui/overflowTitle'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
})

function widths(scroll: number, client: number) {
  const previous = {
    scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
    client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => scroll,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => client,
  })
  return () => {
    for (const [key, descriptor] of [
      ['scrollWidth', previous.scroll],
      ['clientWidth', previous.client],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  }
}

function HiddenLabel({ label }: { label: string }) {
  const name = useOverflowTitle<HTMLSpanElement>(label, { whenHidden: true })
  return (
    <button type="button" title={name.title}>
      <span ref={name.ref} style={{ display: 'none' }}>
        {label}
      </span>
    </button>
  )
}

it('sets the full text only when the line actually overflows', () => {
  const restore = widths(180, 40)
  try {
    act(() => root.render(<OverflowText text="Grok Imagine Video" className="truncate" />))
    expect(host.querySelector('span')?.getAttribute('title')).toBe('Grok Imagine Video')
  } finally {
    restore()
  }
})

it('leaves a fully visible line without a title', () => {
  const restore = widths(40, 180)
  try {
    act(() => root.render(<OverflowText text="Agnes AI" />))
    expect(host.querySelector('span')?.getAttribute('title')).toBeNull()
  } finally {
    restore()
  }
})

it('shows the full label when the name is hidden down to an icon', () => {
  act(() => root.render(<HiddenLabel label="Agnes 2.5 Flash" />))
  expect(host.querySelector('button')?.getAttribute('title')).toBe('Agnes 2.5 Flash')
})
