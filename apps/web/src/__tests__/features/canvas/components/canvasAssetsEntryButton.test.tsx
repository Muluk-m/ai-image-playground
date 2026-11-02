// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import CanvasAssetsEntryButton from '../../../../features/canvas/components/CanvasAssetsEntryButton'
import { useCanvasAssetsEntry } from '../../../../features/canvas/lib/assetsEntry'
import { clearProjectView, setProjectView } from '../../../../features/canvas/lib/canvasView'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useCanvasAssetsEntry.setState({ available: true, open: false })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setProjectView(null)
  useCanvasAssetsEntry.setState({ available: false, open: false })
})

it('对话视图里画布挂着也不出现顶栏「资产」，切到画布视图才出现', () => {
  act(() => setProjectView('p1', 'chat'))
  act(() => root.render(<CanvasAssetsEntryButton />))
  expect(host.querySelector('button')).toBeNull()

  act(() => setProjectView('p1', 'canvas'))
  expect(host.querySelector('button')).not.toBeNull()

  act(() => clearProjectView('p1', 'canvas'))
  expect(host.querySelector('button')).toBeNull()
})
