// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Select from '../../components/Select'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '高', value: 'high' },
  { label: '低', value: 'low' },
]

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

it('opens, moves and selects with the keyboard, exposing combobox and listbox roles', () => {
  const onChange = vi.fn()
  act(() => root.render(<Select value="auto" onChange={onChange} options={OPTIONS} />))
  const trigger = host.querySelector('[role="combobox"]') as HTMLElement
  expect(trigger.tabIndex).toBe(0)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  press(trigger, 'ArrowDown')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(3)
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe(
    '自动',
  )

  press(trigger, 'ArrowDown')
  press(trigger, 'Enter')
  expect(onChange).toHaveBeenCalledWith('high')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('closes on Escape without selecting', () => {
  const onChange = vi.fn()
  act(() => root.render(<Select value="auto" onChange={onChange} options={OPTIONS} />))
  const trigger = host.querySelector('[role="combobox"]') as HTMLElement
  press(trigger, 'Enter')
  press(trigger, 'Escape')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(onChange).not.toHaveBeenCalled()
})
