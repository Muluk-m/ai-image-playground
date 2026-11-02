// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InspirationChips from '../../../../features/inspiration/components/InspirationChips'
import { useInspirationStore } from '../../../../features/inspiration/store'
import type { InspirationItem } from '../../../../features/inspiration/types'

function makeItem(id: string): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: `标题 ${id}`,
    prompt: 'prompt',
    thumbnailUrl: `https://example.com/${id}.jpg`,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category: '海报',
  }
}

let host: HTMLDivElement
let root: Root
let observers: Array<() => void> = []

beforeEach(() => {
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  useInspirationStore.setState({
    items: ['a', 'b', 'c', 'd'].map(makeItem),
    loadRemote: async () => {},
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function setScroll(row: HTMLElement, scrollLeft: number) {
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: 375 })
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 900 })
  row.scrollLeft = scrollLeft
}

it('手机上右边还有 chip 时渐隐右缘，划到底就收掉', () => {
  act(() => root.render(<InspirationChips />))
  const row = host.querySelector<HTMLElement>('.studio-home-chips')!
  setScroll(row, 0)
  act(() => observers.forEach((fire) => fire()))
  expect(row.hasAttribute('data-more')).toBe(true)

  setScroll(row, 525)
  act(() => row.dispatchEvent(new Event('scroll')))
  expect(row.hasAttribute('data-more')).toBe(false)
})
