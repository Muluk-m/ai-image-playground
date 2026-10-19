// @vitest-environment jsdom
import { type Node, ReactFlow } from '@xyflow/react'
import { act, createContext, useContext } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import NodePorts from '../../../../features/canvas/components/NodePorts'

const DetailContext = createContext(false)
const nodes: Node[] = [
  { id: 'source', type: 'card', position: { x: 100, y: 100 }, width: 300, height: 220 },
]
const nodeTypes = {
  card: () => (useContext(DetailContext) ? <NodePorts nodeId="source" /> : <span>Card</span>),
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('can drag a connection when detailed ports replace a card without resizing the node', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m22 = 1
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: target.getBoundingClientRect(),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this,
          ),
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )
  const size = (element: HTMLElement) =>
    element.classList.contains('react-flow__handle')
      ? { width: 6, height: 6 }
      : element.classList.contains('react-flow__node')
        ? { width: 300, height: 220 }
        : { width: 800, height: 600 }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return size(this).width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return size(this).height
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const { width, height } = size(this)
    const handle = this.classList.contains('react-flow__handle')
    const node = this.classList.contains('react-flow__node')
    return new DOMRect(
      handle ? (this.classList.contains('source') ? 397 : 97) : node ? 100 : 0,
      handle ? 207 : node ? 100 : 0,
      width,
      height,
    )
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onConnectStart = vi.fn()
  const render = (detail: boolean) =>
    act(async () => {
      root.render(
        <DetailContext.Provider value={detail}>
          <ReactFlow
            nodes={nodes}
            nodeTypes={nodeTypes}
            onConnectStart={onConnectStart}
            autoPanOnConnect={false}
          />
        </DetailContext.Provider>,
      )
    })
  try {
    await render(false)
    expect(host.querySelector('.react-flow__handle')).toBeNull()
    await render(true)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    const handle = host.querySelector<HTMLElement>('.studio-node-handle')
    if (!handle) throw new Error('Detailed node has no outgoing port')
    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 400, clientY: 210 }),
      )
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 450, clientY: 210 }),
      )
    })
    expect(onConnectStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nodeId: 'source', handleType: 'source' }),
    )
  } finally {
    act(() =>
      document.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, clientX: 450, clientY: 210 }),
      ),
    )
    act(() => root.unmount())
    host.remove()
  }
})
