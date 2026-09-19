// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ThemeToggleButton from '../../components/ThemeToggleButton'
import { setThemeChoice } from '../../theme'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ThemeToggleButton />))
})

afterEach(() => {
  act(() => setThemeChoice('system'))
  act(() => root.unmount())
  host.remove()
  document.documentElement.classList.remove('dark')
  localStorage.clear()
})

describe('登录页的日月按钮', () => {
  it('没登录也能翻转主题，名字说的是点了会发生什么', () => {
    const button = host.querySelector('button')
    if (!button) throw new Error('missing theme button')
    expect(button.getAttribute('aria-label')).toBe('切到暗色')

    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('aip.theme')).toBe('dark')
    expect(button.getAttribute('aria-label')).toBe('切到亮色')
  })
})
