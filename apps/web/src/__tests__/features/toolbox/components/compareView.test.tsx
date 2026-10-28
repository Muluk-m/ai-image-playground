// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import CompareView from '../../../../features/toolbox/components/CompareView'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const clipOf = (src: string) =>
  (host.querySelector(`img[src="${src}"]`) as HTMLImageElement).style.clipPath

it('clips each side to its own half so neither image shows through the other', () => {
  act(() => root.render(<CompareView before="blob:before" after="blob:after" onExit={() => {}} />))
  expect(clipOf('blob:before')).toBe('inset(0 50% 0 0)')
  expect(clipOf('blob:after')).toBe('inset(0 0 0 50%)')

  const slider = host.querySelector('[role="slider"]') as HTMLElement
  act(() => {
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    )
  })
  expect(clipOf('blob:before')).toBe('inset(0 40% 0 0)')
  expect(clipOf('blob:after')).toBe('inset(0 0 0 60%)')
})
