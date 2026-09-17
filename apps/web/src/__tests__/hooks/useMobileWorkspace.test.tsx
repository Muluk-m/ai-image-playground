// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useWorkspaceViewport } from '../../hooks/useMobileWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('fits the workspace to the keyboard viewport and cleans up listeners and styles', () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('innerHeight', 800)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function Harness() {
    useWorkspaceViewport()
    return <textarea />
  }
  try {
    act(() => root.render(<Harness />))
    host.querySelector('textarea')!.focus()
    viewport.height = 420
    viewport.offsetTop = 12
    act(() => viewport.dispatchEvent(new Event('resize')))
    expect(document.documentElement.style.getPropertyValue('--workspace-viewport-height')).toBe(
      '420px',
    )
    expect(document.documentElement.style.getPropertyValue('--workspace-viewport-top')).toBe('12px')
    expect(document.documentElement.dataset.workspaceKeyboard).toBe('true')
    viewport.height = 800
    act(() => viewport.dispatchEvent(new Event('resize')))
    expect(document.documentElement.dataset.workspaceKeyboard).toBe('false')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
  viewport.dispatchEvent(new Event('resize'))
  expect(document.documentElement.style.getPropertyValue('--workspace-viewport-height')).toBe('')
  expect(document.documentElement.dataset.workspaceKeyboard).toBeUndefined()
})
