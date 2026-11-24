// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Toast from '../../components/Toast'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({ toast: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ toast: null })
  vi.useRealTimers()
})

describe('Toast motion lifecycle', () => {
  it('plays enter and exit animations cleanly and cancels exit if a new toast arrives', () => {
    act(() => root.render(<Toast />))
    expect(host.querySelector('[role="status"]')?.className).toContain('-translate-x-1/2')
    expect(host.querySelector('.toast-enter')).toBeNull()

    act(() => useStore.setState({ toast: { message: '已复制', type: 'success' } }))
    expect(host.querySelector('.toast-enter')?.textContent).toContain('已复制')

    act(() => useStore.setState({ toast: null }))
    expect(host.querySelector('.toast-exit')?.textContent).toContain('已复制')

    // New toast mid-exit interrupts the exit and enters cleanly.
    act(() => useStore.setState({ toast: { message: '已保存', type: 'info' } }))
    expect(host.querySelector('.toast-exit')).toBeNull()
    expect(host.querySelector('.toast-enter')?.textContent).toContain('已保存')

    // Clearing removes the node after the exit animation window.
    act(() => useStore.setState({ toast: null }))
    expect(host.querySelector('.toast-exit')).not.toBeNull()
    act(() => vi.advanceTimersByTime(170))
    expect(host.querySelector('.toast-exit')).toBeNull()
    expect(host.querySelector('.toast-enter')).toBeNull()
  })
})
