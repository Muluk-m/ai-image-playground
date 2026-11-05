// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { usePathname } from '../../lib/pathname'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

function Probe() {
  return <span>{usePathname()}</span>
}

beforeEach(() => {
  history.replaceState(null, '', '/image')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('follows every History API write without the writer notifying', async () => {
  await act(async () => root.render(<Probe />))
  expect(host.textContent).toBe('/image')

  await act(async () => history.pushState(null, '', '/changelog'))
  expect(host.textContent).toBe('/changelog')

  await act(async () => history.replaceState(null, '', '/assets?x=1#y'))
  expect(host.textContent).toBe('/assets')
})
