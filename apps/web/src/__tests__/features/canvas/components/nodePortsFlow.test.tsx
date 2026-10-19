// @vitest-environment jsdom
import { type Node, ReactFlow } from '@xyflow/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasLodProvider, useCanvasLod } from '../../../../features/canvas/components/CanvasLod'
import NodePorts from '../../../../features/canvas/components/NodePorts'

const nodes: Node[] = [
  { id: 'source', type: 'card', position: { x: 100, y: 100 }, width: 300, height: 220 },
]
const nodeTypes = {
  card: () => (useCanvasLod() === 'detail' ? <NodePorts nodeId="source" /> : <span>Card</span>),
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
  const measured = new WeakSet<Element>()
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (measured.has(target)) return
        measured.add(target)
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
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this).width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this).height
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
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
  const hitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onConnectStart = vi.fn()
  const render = (detail: boolean) =>
    act(async () => {
      root.render(
        <CanvasLodProvider mode={detail ? 'detail' : 'card'}>
          <ReactFlow
            nodes={nodes}
            nodeTypes={nodeTypes}
            onConnectStart={onConnectStart}
            autoPanOnConnect={false}
          />
        </CanvasLodProvider>,
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
    if (hitTest) Object.defineProperty(document, 'elementFromPoint', hitTest)
    else Reflect.deleteProperty(document, 'elementFromPoint')
  }
})
