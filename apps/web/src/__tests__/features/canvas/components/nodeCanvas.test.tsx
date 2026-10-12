// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  importLegacyElements,
  moveCanvasNodes,
  readCanvasDocument,
} from '@image-playground/shared'
import { act, createElement, type ElementType, type ReactNode, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeCanvas from '../../../../features/canvas/components/NodeCanvas'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import type { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'

const mocks = vi.hoisted(() => ({ open: vi.fn(), importImages: vi.fn(async () => 1) }))
vi.mock('../../../../features/canvas/lib/nodeCanvasDocument', () => ({
  openNodeCanvasDocument: mocks.open,
}))
vi.mock('../../../../features/canvas/lib/importImages', () => ({
  importImageFiles: mocks.importImages,
}))
vi.mock('../../../../features/canvas/lib/konvaShapes', () => ({
  ARROW_POINTER: { length: 12, width: 10 },
  freedrawOutline: () => [0, 0, 1, 1],
}))
vi.mock('../../../../lib/channels/queueClient', () => ({ queueOutputUrl: () => '/clip.mp4' }))
vi.mock('../../../../theme/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
vi.mock('@xyflow/react', () => ({
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  MiniMap: () => null,
  getViewportForBounds: () => ({ x: 0, y: 0, zoom: 1 }),
  Handle: ({ className, children }: { className?: string; children?: ReactNode }) =>
    createElement('span', { className: `react-flow__handle ${className ?? ''}` }, children),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({
    nodes,
    nodeTypes,
    children,
    onInit,
    onPaneClick,
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
    onPaneClick?: () => void
    onInit?: (flow: {
      screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
      setViewport: (viewport: { x: number; y: number; zoom: number }) => void
      getViewport: () => { x: number; y: number; zoom: number }
    }) => void
  }) => {
    const init = useRef(onInit)
    init.current = onInit
    useEffect(() => {
      init.current?.({
        screenToFlowPosition: (point) => point,
        setViewport: () => {},
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      })
    }, [])
    return createElement(
      'div',
      { className: 'react-flow' },
      ...nodes.map((node) =>
        createElement(
          'div',
          {
            key: node.id,
            className: `react-flow__node${node.selected ? ' selected' : ''}`,
            'data-node-id': node.id,
            'data-bounds': JSON.stringify({
              ...node.position,
              width: node.width,
              height: node.height,
            }),
            style: { zIndex: node.zIndex },
          },
          createElement(nodeTypes[node.type], { data: node.data }),
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
const image = (id: string): ImageEl => ({
  id,
  type: 'image',
  fileId: 'file',
  x: 10,
  y: 20,
  width: 100,
  height: 100,
  rotation: 0,
})
function createCanvas(): NodeCanvasDocument {
  const doc = new Y.Doc()
  importLegacyElements(doc, old.elements, canvasOrigin('system', 'fixture'))
  const origin = canvasOrigin('user', 'device')
  return {
    doc,
    origin,
    undo: createCanvasUndoManager(doc, origin),
    destroy: vi.fn(async () => {}),
  }
}
beforeEach(() => {
  mocks.open.mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  old = new CanvasDoc()
  old.elements = [image('image')]
  old.files = { file: 'data:image/png;base64,AA==' }
  canvas = createCanvas()
  workspace = {
    doc: old,
    record: { key: 'fixture' },
    editor: { doc: old },
  } as unknown as CanvasWorkspace
  mocks.open.mockResolvedValue(canvas)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  canvas.undo.destroy()
  canvas.doc.destroy()
  vi.restoreAllMocks()
})
async function render(active = true) {
  await act(async () => root.render(<NodeCanvas workspace={workspace} active={active} />))
}

it('displays images delivered after migration without resetting node edits', async () => {
  await render()
  act(() => moveCanvasNodes(canvas.doc, [{ id: 'image', x: 90, y: 80 }], canvas.origin))
  act(() => old.addElements([image('delivered')]))
  expect(host.querySelector('[data-node-id="delivered"] img')).not.toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === 'image')).toMatchObject({
    x: 90,
    y: 80,
  })
})

it('includes delivery while IndexedDB opening is still pending', async () => {
  let resolve!: (value: NodeCanvasDocument) => void
  mocks.open.mockReturnValue(
    new Promise<NodeCanvasDocument>((accept) => {
      resolve = accept
    }),
  )
  await render()
  act(() => old.addElements([image('during-open')]))
  await act(async () => resolve(canvas))
  expect(host.querySelector('[data-node-id="during-open"] img')).not.toBeNull()
})

it('replays a delivery and its deletion even when migration read the intermediate snapshot', async () => {
  let resolve!: (value: NodeCanvasDocument) => void
  mocks.open.mockReturnValue(
    new Promise<NodeCanvasDocument>((accept) => {
      resolve = accept
    }),
  )
  await render()
  act(() => old.addElements([image('transient')]))
  canvas.undo.destroy()
  canvas.doc.destroy()
  canvas = createCanvas()
  act(() => old.deleteElements(['transient']))
  await act(async () => resolve(canvas))
  expect(readCanvasDocument(canvas.doc).nodes.map((node) => node.id)).toEqual(['image'])
  expect(host.querySelector('[data-node-id="transient"]')).toBeNull()
})

it('ignores undo while hidden or a modal is open and resumes in the active canvas', async () => {
  await render()
  act(() => moveCanvasNodes(canvas.doc, [{ id: 'image', x: 90, y: 80 }], canvas.origin))
  await render(false)
  const undo = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true }),
    )
  act(undo)
  expect(readCanvasDocument(canvas.doc).nodes[0]!.x).toBe(90)
  await render()
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  act(undo)
  expect(readCanvasDocument(canvas.doc).nodes[0]!.x).toBe(90)
  modal.remove()
  act(undo)
  expect(readCanvasDocument(canvas.doc).nodes[0]!.x).toBe(10)
})

it('keeps annotations in the same stacking sequence as media nodes', async () => {
  old.elements = [
    image('first'),
    { id: 'arrow', type: 'arrow', points: [1000, 2000, 1100, 2100], stroke: 'red', strokeWidth: 2 },
    image('last'),
  ]
  canvas.undo.destroy()
  canvas.doc.destroy()
  canvas = createCanvas()
  mocks.open.mockResolvedValue(canvas)
  await render()
  for (const [id, z] of [
    ['first', '0'],
    ['arrow', '1'],
    ['last', '2'],
  ]) {
    expect(host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!.style.zIndex).toBe(z)
  }
  expect(host.querySelector('[data-node-id="arrow"] svg')).not.toBeNull()
  expect(
    JSON.parse(host.querySelector('[data-node-id="arrow"]')!.getAttribute('data-bounds')!),
  ).toEqual({ x: 986, y: 1986, width: 128, height: 128 })
  expect(host.querySelector('[data-node-id="arrow"] svg')!.getAttribute('viewBox')).toBe(
    '986 1986 128 128',
  )
})

it('preserves a video rotation when switching from its poster to playback', async () => {
  old.elements = [
    { ...image('image'), type: 'image', rotation: 30, video: { taskId: 'task', outputIndex: 0 } },
  ]
  canvas.undo.destroy()
  canvas.doc.destroy()
  canvas = createCanvas()
  mocks.open.mockResolvedValue(canvas)
  await render()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
  const video = host.querySelector('video')!
  expect(video.parentElement!.style.transform).toBe('rotate(30deg)')
  expect(video.closest('[data-rotated]')).not.toBeNull()
})

it('opens an add menu on a double-click of the empty canvas', async () => {
  await render()
  const surface = host.querySelector('.studio-node-canvas')!
  act(() => {
    surface.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 48, clientY: 64 }))
  })
  expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('文本')
  expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('图片')
  expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('上传')
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
})

it('puts a composer under a new image node and drops the empty card when dismissed', async () => {
  await render()
  const surface = host.querySelector('.studio-node-canvas')!
  act(() => {
    surface.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 48, clientY: 64 }))
  })
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('图片'),
  )
  act(() => (item as HTMLButtonElement).click())
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
  const composer = host.querySelector('.studio-node-composer')
  expect(composer?.getAttribute('aria-label')).toBe('描述你想生成的图片')
  expect(host.querySelectorAll('.react-flow__handle')).toHaveLength(4)
  const added = readCanvasDocument(canvas.doc).nodes.find((node) => node.id !== 'image')
  expect(added).toMatchObject({ type: 'image', data: {} })
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="pane"]')!.click())
  expect(host.querySelector('.studio-node-composer')).toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes.map((node) => node.id)).toEqual(['image'])
})

it('places a dropped image where the pointer is', async () => {
  mocks.importImages.mockClear()
  await render()
  const surface = host.querySelector('.studio-node-canvas')!
  const file = new File(['png'], 'shot.png', { type: 'image/png' })
  const event = new MouseEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX: 30,
    clientY: 40,
  })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [file], items: [] },
  })
  await act(async () => {
    surface.dispatchEvent(event)
  })
  expect(mocks.importImages).toHaveBeenCalledWith(workspace.editor, [file], { x: 30, y: 40 })
})
