// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasGroup,
  createCanvasUndoManager,
  importLegacyElements,
  readCanvasDocument,
} from '@image-playground/shared'
import {
  act,
  type CSSProperties,
  createElement,
  type ElementType,
  type ReactNode,
  useEffect,
  useRef,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeCanvas from '../../../../features/canvas/components/NodeCanvas'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import { focusNodeCanvas, revealNodeCanvas } from '../../../../features/canvas/lib/nodeCanvasFocus'
import { nodeCanvasSelection } from '../../../../features/canvas/lib/nodeCanvasSelection'
import type { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
import { stubPointerApis } from '../../../helpers/radix'

type TestViewport = { x: number; y: number; zoom: number }

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  importImages: vi.fn(async () => 1),
  submitImage: vi.fn(() => true),
  viewport: { x: 0, y: 0, zoom: 1 },
  setViewport: vi.fn(),
  fit: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
}))
vi.mock('../../../../features/canvas/lib/nodeCanvasDocument', () => ({
  openNodeCanvasDocument: mocks.open,
}))
vi.mock('../../../../features/canvas/lib/nodeCanvasGenerate', () => ({
  fillImageNode: mocks.importImages,
  readImageFile: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,AA==',
    width: 1,
    height: 1,
  })),
  InvalidImageFileError: class extends Error {},
  resumeNodeGenerations: vi.fn(),
  submitNodeImage: mocks.submitImage,
}))
vi.mock('../../../../features/canvas/lib/konvaShapes', () => ({
  ARROW_POINTER: { length: 12, width: 10 },
  freedrawOutline: () => [0, 0, 1, 1],
}))
vi.mock('../../../../theme/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
vi.mock('@xyflow/react', () => ({
  useUpdateNodeInternals: () => () => {},
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  NodeResizer: ({ isVisible }: { isVisible?: boolean }) =>
    createElement('div', { 'data-testid': 'node-resizer', 'data-visible': isVisible }),
  SelectionMode: { Partial: 'partial' },
  MiniMap: () => null,
  getViewportForBounds: mocks.fit,
  Handle: ({
    className,
    children,
    onClick,
    'aria-label': label,
  }: {
    className?: string
    children?: ReactNode
    onClick?: () => void
    'aria-label'?: string
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        className: `react-flow__handle ${className ?? ''}`,
        'aria-label': label,
        onClick,
      },
      children,
    ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useStoreApi: () => ({ getState: () => ({ cancelConnection: () => {} }) }),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({
    nodes,
    nodeTypes,
    children,
    onInit,
    onSelectionChange,
    onNodeClick,
    onPaneClick,
    onMove,
    style,
  }: {
    nodes: {
      id: string
      type: string
      zIndex: number
      data: unknown
      position: { x: number; y: number }
      width: number
      height: number
      selected?: boolean
    }[]
    nodeTypes: Record<string, ElementType>
    children: ReactNode
    onSelectionChange?: (selection: { nodes: { id: string }[] }) => void
    onNodeClick?: (event: unknown, node: { id: string }) => void
    onPaneClick?: () => void
    onMove?: (event: unknown, viewport: TestViewport) => void
    style?: CSSProperties
    onInit?: (flow: {
      screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
      setViewport: (viewport: TestViewport) => void
      getViewport: () => TestViewport
      zoomTo: (zoom: number) => unknown
      flowToScreenPosition: (point: { x: number; y: number }) => { x: number; y: number }
    }) => void
  }) => {
    const init = useRef(onInit)
    init.current = onInit
    useEffect(() => {
      init.current?.({
        screenToFlowPosition: (point) => point,
        setViewport: mocks.setViewport,
        getViewport: () => mocks.viewport,
        zoomTo: () => undefined,
        flowToScreenPosition: (point) => point,
      })
    }, [])
    return createElement(
      'div',
      { className: 'react-flow', style },
      ...nodes.map((node) =>
        createElement(
          'div',
          {
            key: node.id,
            className: `react-flow__node${node.selected ? ' selected' : ''}`,
            'data-node-id': node.id,
            onClick: (event: unknown) => {
              onSelectionChange?.({ nodes: [node] })
              onNodeClick?.(event, node)
            },
          },
          createElement(nodeTypes[node.type], { data: node.data, selected: node.selected }),
        ),
      ),
      children,
      createElement('button', {
        type: 'button',
        'data-testid': 'pane',
        onClick: () => onPaneClick?.(),
      }),
    )
  },
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let old: CanvasDoc
let canvas: NodeCanvasDocument
let workspace: CanvasWorkspace
const image = (id: string, x: number): ImageEl => ({
  id,
  type: 'image',
  fileId: 'file',
  x,
  y: 20,
  width: 100,
  height: 100,
  rotation: 0,
})
function createCanvas(): NodeCanvasDocument {
  const doc = new Y.Doc()
  importLegacyElements(doc, old.elements, canvasOrigin('system', 'fixture'))
  const origin = canvasOrigin('user', 'device')
  return { doc, origin, undo: createCanvasUndoManager(doc, origin), destroy: vi.fn(async () => {}) }
}
beforeEach(() => {
  stubPointerApis()
  mocks.open.mockReset()
  mocks.viewport = { x: 0, y: 0, zoom: 1 }
  mocks.setViewport.mockClear()
  mocks.setViewport.mockImplementation((viewport: TestViewport) => {
    mocks.viewport = viewport
  })
  mocks.fit.mockClear()
  old = new CanvasDoc()
  old.elements = [image('first', 0), image('member', 240)]
  old.files = { file: 'data:image/png;base64,AA==' }
  canvas = createCanvas()
  createCanvasGroup(canvas.doc, 'group', ['member'], 'Group', canvas.origin)
  workspace = {
    doc: old,
    record: { key: 'focus-fixture' },
    editor: new CanvasEditor(old),
  } as unknown as CanvasWorkspace
  mocks.open.mockResolvedValue(canvas)
  host = document.createElement('div')
  document.body.append(host)
  Object.defineProperties(host, { clientWidth: { value: 1000 }, clientHeight: { value: 700 } })
  host.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 700)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  canvas.undo.destroy()
  canvas.doc.destroy()
  vi.restoreAllMocks()
})
async function render() {
  await act(async () => root.render(<NodeCanvas workspace={workspace} active />))
  const container = host.querySelector<HTMLElement>('.studio-node-canvas')!
  Object.defineProperties(container, {
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 700, configurable: true },
  })
  container.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 700)
}

it('focuses a mounted node, including a node inside a group, and reframes repeated requests', async () => {
  await render()
  const editor = workspace.editor
  const initialViewport = { ...mocks.viewport }
  const before = mocks.setViewport.mock.calls.length
  let focused = false
  act(() => {
    focused = focusNodeCanvas(editor, ['member'])
  })
  expect(focused).toBe(true)
  expect(host.querySelector('[data-node-id="member"]')?.classList.contains('selected')).toBe(true)
  expect(mocks.viewport).not.toEqual(initialViewport)
  expect(mocks.setViewport.mock.calls.length).toBeGreaterThan(before)
  const afterFirst = mocks.setViewport.mock.calls.length
  act(() => {
    focused = focusNodeCanvas(editor, ['member'])
  })
  expect(focused).toBe(true)
  expect(mocks.setViewport.mock.calls.length).toBeGreaterThan(afterFirst)
})

it('leaves an uncommitted arrangement before locating the original node without changing the document', async () => {
  await render()
  const before = readCanvasDocument(canvas.doc)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="整理画布"]')!.click())
  expect(host.textContent).toContain('是否保留此次整理结果？')
  act(() => {
    expect(focusNodeCanvas(workspace.editor, ['member'])).toBe(true)
  })
  expect(host.textContent).not.toContain('是否保留此次整理结果？')
  expect(host.querySelector('[data-node-id="member"]')?.classList.contains('selected')).toBe(true)
  expect(readCanvasDocument(canvas.doc)).toEqual(before)
})

it('does not focus missing nodes or another editor and unregisters when unmounted', async () => {
  await render()
  const editor = workspace.editor
  const before = mocks.setViewport.mock.calls.length
  expect(focusNodeCanvas(editor, ['missing'])).toBe(false)
  expect(focusNodeCanvas({ doc: old } as unknown as typeof editor, ['member'])).toBe(false)
  expect(mocks.setViewport.mock.calls.length).toBe(before)
  act(() => root.render(null))
  expect(focusNodeCanvas(editor, ['member'])).toBe(false)
  expect(mocks.setViewport.mock.calls.length).toBe(before)
})

it('reveals an offscreen node without replacing references or changing zoom', async () => {
  await render()
  act(() => focusNodeCanvas(workspace.editor, ['first']))
  mocks.viewport = { x: -2000, y: -1000, zoom: 0.5 }
  act(() => expect(revealNodeCanvas(workspace.editor, ['member'])).toBe(true))
  expect(nodeCanvasSelection(workspace.editor)).toEqual(['first'])
  expect(mocks.viewport.zoom).toBe(0.5)
  expect(240 * mocks.viewport.zoom + mocks.viewport.x).toBe(16)
  expect(20 * mocks.viewport.zoom + mocks.viewport.y).toBeGreaterThanOrEqual(16)
  const visible = { ...mocks.viewport }
  act(() => expect(revealNodeCanvas(workspace.editor, ['member'])).toBe(true))
  expect(mocks.viewport).toEqual(visible)
})

it('aligns an oversized batch to the available top left without zooming out', async () => {
  await render()
  mocks.viewport = { x: 100, y: 100, zoom: 4 }
  act(() => expect(revealNodeCanvas(workspace.editor, ['first', 'member'])).toBe(true))
  expect(mocks.viewport.x).toBe(16)
  expect(mocks.viewport.zoom).toBe(4)
  const aligned = { ...mocks.viewport }
  act(() => expect(revealNodeCanvas(workspace.editor, ['first', 'member'])).toBe(true))
  expect(mocks.viewport).toEqual(aligned)
  expect(nodeCanvasSelection(workspace.editor)).toEqual([])
  act(() => root.render(null))
  expect(revealNodeCanvas(workspace.editor, ['first'])).toBe(false)
})

it.each([
  'image',
  'video',
] as const)('reveals freshly synchronized %s reservations while keeping the selected reference', async (media) => {
  old.setViewport(1000, 700)
  await render()
  act(() => focusNodeCanvas(workspace.editor, ['first']))
  mocks.viewport = { x: -3000, y: -2000, zoom: 0.5 }
  const sink = createAgentCanvasSink(workspace.editor)
  let ids: readonly string[] = []
  await act(async () => {
    ids = await sink.reserve({ count: 1, media, messageId: 'reservation', anchorObjectId: 'first' })
  })
  const pending = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === ids[0])!
  expect(pending.data).toMatchObject({ pending: { status: 'loading' } })
  expect(nodeCanvasSelection(workspace.editor)).toEqual(['first'])
  expect(mocks.viewport.zoom).toBe(0.5)
  expect(pending.x * mocks.viewport.zoom + mocks.viewport.x).toBe(16)
  expect(pending.y * mocks.viewport.zoom + mocks.viewport.y).toBeGreaterThanOrEqual(16)
})

it('keeps React Flow navigation ownership while its mounted container is hidden', async () => {
  await render()
  Object.defineProperties(host.querySelector('.studio-node-canvas')!, {
    clientWidth: { value: 0, configurable: true },
    clientHeight: { value: 0, configurable: true },
  })
  const legacyScroll = vi.spyOn(workspace.editor, 'scrollToElements')
  const viewport = { ...mocks.viewport }
  await act(async () => {
    await createAgentCanvasSink(workspace.editor).reserve({ count: 1, messageId: 'hidden' })
  })
  expect(legacyScroll).not.toHaveBeenCalled()
  expect(mocks.viewport).toEqual(viewport)
})

it('does not restore the pre-arrangement viewport over a newly revealed reservation', async () => {
  await render()
  const before = readCanvasDocument(canvas.doc)
  mocks.viewport = { x: -5000, y: -5000, zoom: 0.2 }
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="整理画布"]')!.click())
  expect(host.textContent).toContain('是否保留此次整理结果？')
  const zoom = mocks.viewport.zoom
  let ids: readonly string[] = []
  await act(async () => {
    ids = await createAgentCanvasSink(workspace.editor).reserve({ count: 1, messageId: 'arranged' })
  })
  expect(host.textContent).not.toContain('是否保留此次整理结果？')
  expect(mocks.viewport.zoom).toBe(zoom)
  const after = readCanvasDocument(canvas.doc)
  expect(after.nodes.filter((node) => !ids.includes(node.id))).toEqual(before.nodes)
  const pending = after.nodes.find((node) => node.id === ids[0])!
  expect(pending.x * zoom + mocks.viewport.x).toBeGreaterThanOrEqual(16)
  expect(pending.y * zoom + mocks.viewport.y).toBeGreaterThanOrEqual(16)
  expect((pending.x + pending.width) * zoom + mocks.viewport.x).toBeLessThanOrEqual(984)
  expect((pending.y + pending.height) * zoom + mocks.viewport.y).toBeLessThanOrEqual(684)
})
