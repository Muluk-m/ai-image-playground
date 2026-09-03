// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssetHint from '../../../../features/library/components/AssetHint'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({ assetHintShown: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(<AssetHint />))
}

describe('the first reference image hint', () => {
  it('tells the user the thumbnail can become an asset, and marks itself shown', () => {
    render()

    expect(host.textContent).toContain('右键可存为素材')
    expect(useStore.getState().assetHintShown).toBe(true)
  })

  it('never comes back after a reload', () => {
    useStore.setState({ assetHintShown: true })
    render()

    expect(host.textContent).toBe('')
  })

  it('can be closed right away', () => {
    render()

    const close = host.querySelector('[aria-label="关闭提示"]')
    act(() => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toBe('')
  })
})
