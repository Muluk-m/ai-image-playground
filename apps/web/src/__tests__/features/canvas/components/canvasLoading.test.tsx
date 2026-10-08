// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../features/canvas/lib/persistence', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../features/canvas/lib/persistence')>()
  return {
    ...actual,
    readPersistedScene: () => new Promise(() => {}),
  }
})

import CanvasMode from '../../../../features/canvas/components/CanvasMode'
import { currentCanvasWorkspace } from '../../../../features/canvas/lib/activeProject'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { LOADING_MARK_HOLD_MS } from '../../../../hooks/useHeldLoading'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: true,
    error: null,
    routeError: null,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  currentCanvasWorkspace().dispose()
  vi.useRealTimers()
})

describe('opening a canvas', () => {
  it('keeps the brand mark off the screen until the restore has actually taken a while', () => {
    act(() => {
      root.render(<CanvasMode />)
    })

    expect(host.querySelector('.studio-canvas-loading-mark')).toBeNull()
    expect(host.querySelector('.studio-shell > .studio-canvas-loading')).toBeNull()
    expect(host.querySelector('.studio-canvas-ground')).not.toBeNull()
    expect(host.querySelector('.studio-shell [role="status"]')?.textContent).toBe('正在恢复画布…')

    act(() => {
      vi.advanceTimersByTime(LOADING_MARK_HOLD_MS - 1)
    })
    expect(host.querySelector('.studio-canvas-loading-mark')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const mark = host.querySelector('.studio-canvas-loading-mark')
    expect(mark).not.toBeNull()
    expect(mark?.closest('.studio-canvas')).not.toBeNull()
    expect(host.querySelector('.studio-shell > .studio-canvas-loading')).toBeNull()
  })
})
