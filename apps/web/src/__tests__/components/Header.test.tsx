// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Header from '../../components/Header'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({ appMode: 'browse' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function modeButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

describe('the mode switch', () => {
  it('offers the workbench, the canvas, the remix and the background swap mode', () => {
    act(() => root.render(<Header />))

    expect(modeButton('工作台').getAttribute('aria-pressed')).toBe('true')
    expect(modeButton('创作')).toBeTruthy()
    expect(modeButton('复刻套图')).toBeTruthy()
    expect(modeButton('换背景')).toBeTruthy()
  })

  it('switches to the remix mode when it is picked', () => {
    act(() => root.render(<Header />))

    act(() => {
      modeButton('复刻套图').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useStore.getState().appMode).toBe('remix')
    expect(modeButton('复刻套图').getAttribute('aria-pressed')).toBe('true')
  })

  it('switches to the background swap mode when it is picked', () => {
    act(() => root.render(<Header />))

    act(() => {
      modeButton('换背景').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useStore.getState().appMode).toBe('bgswap')
    expect(modeButton('换背景').getAttribute('aria-pressed')).toBe('true')
  })
})
