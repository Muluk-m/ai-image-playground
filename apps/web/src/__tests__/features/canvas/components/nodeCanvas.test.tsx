// @vitest-environment jsdom
import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  IMAGE_PRESETS,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  updateCanvasNode,
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
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import type { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
import { useActiveLook } from '../../../../features/library/lib/activeLook'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord, LookRecord } from '../../../../features/library/types'
import { i18next } from '../../../../i18n'
import {
  createBuiltinEdgeProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../../../../lib/apiProfiles'
import { resetChannelCatalog, setChannels } from '../../../../lib/channels/channelStore'
import * as cloudMedia from '../../../../lib/cloudMedia'
import * as downloads from '../../../../lib/downloadImages'
import { useStore } from '../../../../store'
import { captureClientErrors } from '../../../helpers/clientErrors'
import { stubPointerApis } from '../../../helpers/radix'

type TestViewport = { x: number; y: number; zoom: number }

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  importImages: vi.fn(async () => 1),
  readImage: vi.fn(async (_file: File) => ({
    dataUrl: 'data:image/png;base64,AA==',
    width: 1,
    height: 1,
  })),
  submitImage: vi.fn(() => true),
  viewport: { x: 0, y: 0, zoom: 1 },
  move: null as ((viewport: TestViewport) => void) | null,
  hiddenNodeIds: new Set<string>(),
  setViewport: vi.fn(),
  fit: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  videoAvailable: true,
}))
vi.mock('../../../../lib/channels/videoChannels', async (original) => ({
  ...(await original<typeof import('../../../../lib/channels/videoChannels')>()),
  isVideoModeAvailable: () => mocks.videoAvailable,
}))
vi.mock('../../../../features/canvas/lib/nodeCanvasDocument', () => ({
  openNodeCanvasDocument: mocks.open,
}))
vi.mock('../../../../features/canvas/lib/nodeCanvasGenerate', () => ({
  fillImageNode: mocks.importImages,
  readImageFile: mocks.readImage,
  InvalidImageFileError: class extends Error {
    constructor(readonly fileName: string) {
      super('invalid_image_file')
    }
  },
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
    edges,
    nodeTypes,
    children,
    onInit,
    onPaneClick,
    onNodeClick,
    onEdgeClick,
    onConnect,
    onConnectStart,
    onConnectEnd,
    onSelectionChange,
    onMove,
    style,
    className,
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
      className?: string
    }[]
    edges?: {
      id: string
      source: string
      target: string
      selected?: boolean
      data?: { onCut?: () => void }
    }[]
    nodeTypes: Record<string, ElementType>
    children: ReactNode
    onSelectionChange?: (selection: { nodes: { id: string }[] }) => void
    onMove?: (event: unknown, viewport: TestViewport) => void
    style?: CSSProperties
    className?: string
    onNodeClick?: (event: unknown, node: { id: string }) => void
    onEdgeClick?: (event: { stopPropagation: () => void }, edge: { id: string }) => void
    onConnect?: (connection: { source: string; target: string }) => void
    onConnectStart?: (
      event: { clientX: number; clientY: number },
      params: { nodeId: string; handleType: 'source' | 'target' },
    ) => void
    onConnectEnd?: (
      event: { clientX: number; clientY: number },
      state: {
        fromNode: { id: string } | null
        fromHandle: { type: 'source' | 'target' } | null
      },
    ) => void
    onPaneClick?: () => void
    onInit?: (flow: {
      screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
      setViewport: (viewport: { x: number; y: number; zoom: number }) => void
      getViewport: () => { x: number; y: number; zoom: number }
    }) => void
  }) => {
    const init = useRef(onInit)
    init.current = onInit
    mocks.move = (viewport) => {
      mocks.viewport = viewport
      onMove?.(null, viewport)
    }
    useEffect(() => {
      init.current?.({
        screenToFlowPosition: (point) => point,
        setViewport: mocks.setViewport,
        getViewport: () => mocks.viewport,
      })
    }, [])
    return createElement(
      'div',
      { className: `react-flow ${className ?? ''}`, style },
      ...nodes
        .filter((node) => !mocks.hiddenNodeIds.has(node.id))
        .map((node) =>
          createElement(
            'div',
            {
              key: node.id,
              className: `react-flow__node${node.selected ? ' selected' : ''}${node.className ? ` ${node.className}` : ''}`,
              'data-node-id': node.id,
              onClick: (event: unknown) => {
                onSelectionChange?.({ nodes: [node] })
                onNodeClick?.(event, node)
              },
              'data-bounds': JSON.stringify({
                ...node.position,
                width: node.width,
                height: node.height,
              }),
              style: { zIndex: node.zIndex },
            },
            createElement(nodeTypes[node.type], { data: node.data, selected: node.selected }),
          ),
        ),
      ...(edges ?? []).flatMap((edge) => [
        createElement('button', {
          key: edge.id,
          type: 'button',
          'data-edge-id': edge.id,
          onClick: (event: { stopPropagation: () => void }) => onEdgeClick?.(event, edge),
        }),
        ...(edge.selected && edge.data?.onCut
          ? [
              createElement('button', {
                key: `${edge.id}:cut`,
                type: 'button',
                'data-edge-cut': edge.id,
                onClick: edge.data.onCut,
              }),
            ]
          : []),
      ]),
      createElement('button', {
        type: 'button',
        'data-testid': 'start-connection',
        onClick: () =>
          onConnectStart?.({ clientX: 0, clientY: 0 }, { nodeId: 'image', handleType: 'source' }),
      }),
      createElement('button', {
        type: 'button',
        'data-testid': 'commit-connection',
        onClick: () => onConnect?.({ source: 'image', target: 'second' }),
      }),
      createElement('button', {
        type: 'button',
        'data-testid': 'drop-connection',
        onClick: () =>
          onConnectEnd?.(
            { clientX: 100, clientY: 120 },
            { fromNode: { id: 'image' }, fromHandle: { type: 'source' } },
          ),
      }),
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
  stubPointerApis()
  mocks.open.mockReset()
  mocks.submitImage.mockClear()
  mocks.viewport = { x: 0, y: 0, zoom: 1 }
  mocks.hiddenNodeIds.clear()
  mocks.setViewport.mockClear()
  mocks.fit.mockClear()
  mocks.videoAvailable = true
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

it('labels imageless assets as pending and removes the label when a real image arrives', async () => {
  insertCanvasNode(
    canvas.doc,
    {
      id: 'asset-pending',
      type: 'image',
      x: 200,
      y: 0,
      width: 360,
      height: 240,
      data: {
        name: '林夏',
        meta: { nodeKind: 'asset', assetKind: 'person', assetDescription: '插画师' },
      },
    },
    canvas.origin,
  )
  await render()
  const asset = () => host.querySelector<HTMLElement>('[data-node-id="asset-pending"]')!
  expect(asset().textContent).toContain('待出图')
  expect(host.querySelector('[data-node-id="image"]')?.textContent).not.toContain('待出图')
  await act(async () => {
    updateCanvasNode(
      canvas.doc,
      'asset-pending',
      {
        data: { fileId: 'file', name: '林夏', meta: { nodeKind: 'asset', assetKind: 'person' } },
      },
      canvas.origin,
    )
  })
  expect(asset().textContent).not.toContain('待出图')
  expect(asset().querySelector('img')).not.toBeNull()
})

it.each([
  'original',
  'fetch',
  'blob',
  'trigger',
  'missing',
])('reports the real download button %s failure with a safe payload', async (stage) => {
  const reports = captureClientErrors()
  const secret = 'SECRET-node-download-url-filename-prompt'
  const error = Object.assign(new TypeError(secret), { code: secret, cause: new Error(secret) })
  if (stage === 'missing') old.files = {}
  await render()
  act(() => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
  const button = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18next.t('nodes.download', { ns: 'canvas' })}"]`,
  )
  expect(button).not.toBeNull()
  const toast = vi.spyOn(useStore.getState(), 'showToast').mockImplementation(() => {})
  const resolved = vi.spyOn(cloudMedia, 'resolveMediaSource')
  if (stage === 'original') resolved.mockRejectedValue(error)
  else resolved.mockResolvedValue(`https://storage.test/${secret}`)
  const response = new Response('bytes', { headers: { 'content-type': 'image/png' } })
  if (stage === 'blob') vi.spyOn(response, 'blob').mockRejectedValue(error)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  if (stage === 'fetch') fetch.mockRejectedValue(error)
  if (stage === 'trigger') {
    const previous = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => {
        throw error
      },
    })
    try {
      await act(async () => button!.click())
    } finally {
      if (previous) Object.defineProperty(URL, 'createObjectURL', previous)
      else Reflect.deleteProperty(URL, 'createObjectURL')
    }
  } else await act(async () => button!.click())
  if (stage !== 'missing')
    expect(toast).toHaveBeenCalledWith(i18next.t('import.failed', { ns: 'canvas' }), 'error')
  else expect(toast).not.toHaveBeenCalled()
  const errors = (await reports()).flatMap((batch) => batch.errors)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toMatchObject({
    operation: 'download.prepare',
    stage: stage === 'missing' ? 'original' : stage,
  })
  expect(JSON.stringify(await reports())).not.toContain(secret)
})

it('does not report file-save success when the real download button only triggers a download', async () => {
  const reports = captureClientErrors()
  await render()
  act(() => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
  const button = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18next.t('nodes.download', { ns: 'canvas' })}"]`,
  )
  expect(button).not.toBeNull()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('bytes', {
      headers: { 'content-type': 'image/png' },
    }),
  )
  const trigger = vi.spyOn(downloads, 'downloadBlob').mockImplementation(() => {})
  const toast = vi.spyOn(useStore.getState(), 'showToast').mockImplementation(() => {})
  await act(async () => button!.click())
  expect(trigger).toHaveBeenCalledTimes(1)
  expect(toast).not.toHaveBeenCalled()
  expect(await reports()).toEqual([])
})

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

it('keeps uploaded media mounted below the LOD threshold and restores it after viewport culling', async () => {
  await render()
  const picture = host.querySelector<HTMLImageElement>('[data-node-id="image"] img')!
  const source = picture.src
  act(() => mocks.move?.({ x: 100, y: 80, zoom: 0.2 }))
  expect(host.querySelector('[data-node-id="image"] img')).toBe(picture)
  expect(picture.src).toBe(source)
  expect(host.querySelector('[data-node-id="image"] [data-lod="card"]')).toBeNull()
  mocks.hiddenNodeIds.add('image')
  act(() => mocks.move?.({ x: -5000, y: 80, zoom: 0.2 }))
  expect(host.querySelector('[data-node-id="image"]')).toBeNull()
  mocks.hiddenNodeIds.clear()
  act(() => mocks.move?.({ x: 0, y: 0, zoom: 2.43 }))
  expect(host.querySelector<HTMLImageElement>('[data-node-id="image"] img')?.src).toBe(source)
  expect(
    host.querySelector<HTMLElement>('.react-flow')?.style.getPropertyValue('--studio-node-zoom'),
  ).toBe('2.43')
})

it('projects restored media to standard bounds without writing cosmetic updates to the document', async () => {
  updateCanvasNode(canvas.doc, 'image', { width: 48, height: 2400 }, canvas.origin)
  const before = readCanvasDocument(canvas.doc)
  const updates = vi.fn()
  canvas.doc.on('update', updates)
  await render()
  expect(
    JSON.parse(host.querySelector('[data-node-id="image"]')!.getAttribute('data-bounds')!),
  ).toEqual({ x: 10, y: 20, width: 360, height: 240 })
  expect(readCanvasDocument(canvas.doc)).toEqual(before)
  expect(updates).not.toHaveBeenCalled()
  act(() => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
  expect(host.querySelector('[data-node-id="image"] [data-testid="node-resizer"]')).toBeNull()
  canvas.doc.off('update', updates)
})
it.each([
  { width: 1200, tools: [16, 100, 56, 480], top: 46, left: 88, availableWidth: 1096 },
  { width: 600, tools: [8, 8, 584, 48], top: 102, left: 16, availableWidth: 568 },
])('fits inside measured composer and toolbar bounds at $width pixels', async (layout) => {
  await render()
  act(() => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
  const container = host.querySelector<HTMLElement>('.studio-node-canvas')!
  Object.defineProperties(container, {
    clientWidth: { value: layout.width },
    clientHeight: { value: 800 },
  })
  container.getBoundingClientRect = () => new DOMRect(0, 0, layout.width, 800)
  const measure = (selector: string, values: number[]) => {
    const element = document.querySelector<HTMLElement>(selector)!
    element.getBoundingClientRect = () => new DOMRect(values[0], values[1], values[2], values[3])
  }
  measure('.studio-node-tools', layout.tools)
  measure('.studio-node-navigation', [16, 740, 320, 44])
  measure('.studio-node-composer', [200, 550, 560, 234])
  const fit = host.querySelector<HTMLButtonElement>(
    `[aria-label="${i18next.t('nodes.fit', { ns: 'canvas' })}"]`,
  )!
  act(() => fit.click())
  expect(mocks.fit).toHaveBeenLastCalledWith(
    { x: 10, y: 20, width: 360, height: 240 },
    layout.availableWidth,
    534 - layout.top,
    0.05,
    8,
    0.25,
  )
  expect(mocks.setViewport).toHaveBeenLastCalledWith(
    { x: layout.left, y: layout.top, zoom: 1 },
    { duration: 250 },
  )
  measure('.studio-node-composer', [200, 420, 560, 364])
  act(() => fit.click())
  expect(mocks.fit).toHaveBeenLastCalledWith(
    { x: 10, y: 20, width: 360, height: 240 },
    layout.availableWidth,
    404 - layout.top,
    0.05,
    8,
    0.25,
  )
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
  const poster = host.querySelector('[data-node-id="image"] img')
  act(() => mocks.move?.({ x: 0, y: 0, zoom: 0.2 }))
  expect(host.querySelector('[data-node-id="image"] img')).toBe(poster)
  expect(host.querySelector('[data-node-id="image"] [data-testid="node-resizer"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
  const video = host.querySelector('video')!
  expect(video.parentElement!.style.transform).toBe('rotate(30deg)')
  expect(video.closest('[data-rotated]')).not.toBeNull()
  expect(host.querySelector('[data-node-id="image"] .studio-node-caption')).not.toBeNull()
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
  expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('剧本设定')
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
})

it('opens viewport-docked workspace image controls for a new image card and keeps the card', async () => {
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
  expect(composer?.querySelector('.creation-composer')).not.toBeNull()
  expect(composer?.querySelector('[aria-label^="生成设置"]')).not.toBeNull()
  expect(host.querySelector('.studio-node-upload')?.textContent).toContain('上传')
  expect(host.querySelectorAll('.react-flow__handle')).toHaveLength(4)
  const added = readCanvasDocument(canvas.doc).nodes.find((node) => node.id !== 'image')
  expect(added).toMatchObject({ type: 'image', data: {} })
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="pane"]')!.click())
  expect(host.querySelector('.studio-node-composer')).toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes.map((node) => node.id)).toEqual(['image', added!.id])
})

it('places a text card that stays large enough for the side handles', async () => {
  await render()
  const surface = host.querySelector('.studio-node-canvas')!
  act(() => {
    surface.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 80, clientY: 90 }))
  })
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('文本'),
  )
  act(() => (item as HTMLButtonElement).click())
  const added = readCanvasDocument(canvas.doc).nodes.find((node) => node.type === 'text')
  expect(added).toMatchObject({ width: 300, height: 220 })
  const bounds = JSON.parse(
    host.querySelector(`[data-node-id="${added!.id}"]`)!.getAttribute('data-bounds')!,
  )
  expect(bounds.width).toBe(300)
  expect(bounds.height).toBe(220)
})

it('offers node types only from the right handle and connects the chosen downstream node', async () => {
  await render()
  const handle = (label: string) =>
    host.querySelector<HTMLButtonElement>(`[data-node-id="image"] [aria-label="${label}"]`)!
  const choose = (label: string) =>
    act(() => {
      const item = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (el) => el.textContent?.trim() === label,
      )!
      item.click()
    })
  act(() => handle('接到下一个节点').click())
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(1)
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('视频')
  choose('图片')
  const added = readCanvasDocument(canvas.doc).nodes.find((n) => n.id !== 'image')!
  expect(readCanvasDocument(canvas.doc).edges).toContainEqual(
    expect.objectContaining({ source: 'image', target: added.id }),
  )
  expect(handle('接入上文')).toBeNull()
})
it('greys out a new video node while the deployment has no video model', async () => {
  const videoItem = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === '视频',
    )
  const surface = () => host.querySelector('.studio-node-canvas')!
  const openMenu = () =>
    act(() => {
      surface().dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 48, clientY: 64 }),
      )
    })
  mocks.videoAvailable = false
  await render()
  openMenu()
  expect(videoItem()?.disabled).toBe(true)
  act(() => videoItem()!.click())
  expect(readCanvasDocument(canvas.doc).nodes.map((node) => node.id)).toEqual(['image'])
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  // 菜单开着时清单刷新回来、有了视频模型：不用等别的重渲染，入口就可用。
  openMenu()
  expect(videoItem()?.disabled).toBe(true)
  mocks.videoAvailable = true
  act(() => setChannels([]))
  expect(videoItem()?.disabled).toBe(false)
  resetChannelCatalog()
})
it('keeps a selected connection until the explicit cut action is clicked', async () => {
  await render()
  act(() => old.addElements([image('second')]))
  act(() => connectCanvasNodes(canvas.doc, { source: 'image', target: 'second' }, canvas.origin))
  const firstEdge = host.querySelector<HTMLButtonElement>('[data-edge-id="image:second"]')!
  act(() => firstEdge.click())
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  const selectedEdge = host.querySelector<HTMLButtonElement>('[data-edge-id="image:second"]')!
  act(() => selectedEdge.click())
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)

  const cut = host.querySelector<HTMLButtonElement>('[data-edge-cut="image:second"]')
  expect(cut).not.toBeNull()
  act(() => cut!.click())
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
})
it('dims unsupported nodes and highlights the whole valid target card while dragging', async () => {
  Object.assign(workspace.editor, { getElement: () => undefined })
  await render()
  act(() => old.addElements([image('second')]))
  act(() =>
    insertCanvasNode(
      canvas.doc,
      {
        id: 'timeline',
        type: 'timeline',
        x: 10,
        y: 300,
        width: 560,
        height: 240,
        data: { clips: [] },
      },
      canvas.origin,
    ),
  )
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="start-connection"]')!.click())
  expect(host.querySelector('[data-node-id="second"]')?.className).toContain(
    'studio-node-connection-eligible',
  )
  expect(host.querySelector('[data-node-id="timeline"]')?.className).toContain(
    'studio-node-connection-disabled',
  )
})

it('commits an active drag through React Flow before its end callback', async () => {
  await render()
  act(() => old.addElements([image('second')]))
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="start-connection"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="commit-connection"]')!.click())
  expect(readCanvasDocument(canvas.doc).edges).toContainEqual(
    expect.objectContaining({ source: 'image', target: 'second' }),
  )
})

it('restores the scene on Escape and ignores the subsequent connection drop', async () => {
  await render()
  act(() => old.addElements([image('second')]))
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="start-connection"]')!.click())
  expect(host.querySelector('.studio-node-connecting')).not.toBeNull()
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.studio-node-connecting')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="commit-connection"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="drop-connection"]')!.click())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
})

it('opens the add-node menu when a connection ends on blank canvas space', async () => {
  await render()
  const original = (
    document as Document & { elementsFromPoint?: typeof document.elementsFromPoint }
  ).elementsFromPoint
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: () => [],
  })
  try {
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="start-connection"]')!.click())
    expect(host.querySelector('[data-node-id="image"]')?.className).toContain(
      'studio-node-connection-source',
    )
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="drop-connection"]')!.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('文本')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('图片')
  } finally {
    if (original)
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: original })
    else Reflect.deleteProperty(document, 'elementsFromPoint')
  }
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
  const created = readCanvasDocument(canvas.doc).nodes.find(
    (n) => n.id !== 'image' && n.type === 'image',
  )!
  expect(created.x + created.width / 2).toBe(30)
  expect(mocks.importImages).toHaveBeenCalledWith(
    workspace.editor,
    canvas.doc,
    created.id,
    { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 },
    'shot.png',
  )
  act(() => canvas.undo.undo())
  expect(readCanvasDocument(canvas.doc).nodes.some((n) => n.id === created.id)).toBe(false)
})

it('rejects an empty or fake image before creating a node, and says which file', async () => {
  const { InvalidImageFileError } = await import(
    '../../../../features/canvas/lib/nodeCanvasGenerate'
  )
  mocks.importImages.mockClear()
  mocks.readImage.mockImplementationOnce(async (file: File) => {
    throw new InvalidImageFileError(file.name)
  })
  const toast = vi.spyOn(useStore.getState(), 'showToast')
  await render()
  const before = readCanvasDocument(canvas.doc).nodes.length
  const surface = host.querySelector('.studio-node-canvas')!
  const event = new MouseEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX: 30,
    clientY: 40,
  })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      files: [new File(['not an image'], 'fake.png', { type: 'image/png' })],
      items: [],
    },
  })
  await act(async () => {
    surface.dispatchEvent(event)
  })
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('fake.png'), 'error'),
  )
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(before)
  expect(mocks.importImages).not.toHaveBeenCalled()
})

it('leaves selection intact when Escape closes a model listbox', async () => {
  await render()
  act(() =>
    host
      .querySelector('.studio-node-canvas')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 48, clientY: 64 })),
  )
  act(() =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.trim() === '图片')!
      .click(),
  )
  const listbox = document.createElement('div')
  listbox.setAttribute('role', 'listbox')
  document.body.append(listbox)
  expect(host.querySelector('.studio-node-composer')).not.toBeNull()
  act(() => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.studio-node-composer')).not.toBeNull()
  listbox.remove()
})

it('offers video tools and preview when the video has no poster file', async () => {
  const { insertCanvasNode } = await import('@image-playground/shared')
  insertCanvasNode(
    canvas.doc,
    {
      id: 'posterless',
      type: 'video',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { video: { taskId: 'fixture', outputIndex: 0 } },
    },
    canvas.origin,
  )
  await render()
  act(() => host.querySelector<HTMLElement>('[data-node-id="posterless"]')!.click())
  expect(host.querySelector('button[aria-label="视频工具"]')).not.toBeNull()
  expect(host.querySelector('button[aria-label="全屏查看"]')).not.toBeNull()
})

it('previews arrangement without saving, reverts it, and keeps it as one undo step', async () => {
  await render()
  act(() => old.addElements([image('second')]))
  act(() => connectCanvasNodes(canvas.doc, { source: 'image', target: 'second' }, canvas.origin))
  const before = readCanvasDocument(canvas.doc).nodes
  const edges = readCanvasDocument(canvas.doc).edges
  const click = (label: string) =>
    act(() => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent === label,
      )
      expect(button).toBeDefined()
      button!.click()
    })
  click('整理画布')
  expect(readCanvasDocument(canvas.doc).nodes).toEqual(before)
  expect(readCanvasDocument(canvas.doc).edges).toEqual(edges)
  expect(host.textContent).toContain('是否保留此次整理结果？')
  click('还原')
  expect(host.textContent).not.toContain('是否保留此次整理结果？')
  click('整理画布')
  click('保留')
  expect(readCanvasDocument(canvas.doc).nodes).not.toEqual(before)
  expect(readCanvasDocument(canvas.doc).edges).toEqual(edges)
  act(() => canvas.undo.undo())
  expect(readCanvasDocument(canvas.doc).nodes).toEqual(before)
  expect(readCanvasDocument(canvas.doc).edges).toEqual(edges)
})

it('keeps arrangement through media updates but cancels it when another editor moves a node', async () => {
  await render()
  act(() => old.addElements([image('second')]))
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="整理画布"]')!.click())
  act(() =>
    updateCanvasNode(
      canvas.doc,
      'image',
      { data: { fileId: 'file', name: 'Updated' } },
      canvasOrigin('system', 'remote'),
    ),
  )
  expect(host.textContent).toContain('是否保留此次整理结果？')
  act(() =>
    moveCanvasNodes(
      canvas.doc,
      [{ id: 'image', x: 200, y: 200 }],
      canvasOrigin('system', 'remote'),
    ),
  )
  expect(host.textContent).not.toContain('是否保留此次整理结果？')
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === 'image')).toMatchObject({
    x: 200,
    y: 200,
  })
})

it('picks compatible references from the canvas without changing the target selection', async () => {
  await render()
  const click = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)!.click())
  click('.studio-node-tools [aria-label="图片"]')
  const target = readCanvasDocument(canvas.doc).nodes.find((n) => n.id !== 'image')!
  act(() =>
    insertCanvasNode(
      canvas.doc,
      {
        id: 'empty-video',
        type: 'image',
        x: 0,
        y: 0,
        width: 360,
        height: 240,
        data: { meta: { nodeKind: 'video' } },
      },
      canvas.origin,
    ),
  )
  click('[aria-label="添加引用"]')
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '从画布选择')!
      .click(),
  )
  expect(host.querySelector('.studio-node-pick-banner')).not.toBeNull()
  click('[data-node-id="empty-video"]')
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
  click('[data-node-id="image"]')
  expect(readCanvasDocument(canvas.doc).edges).toEqual([
    expect.objectContaining({ source: 'image', target: target.id }),
  ])
  expect(host.querySelector('.studio-node-composer')?.getAttribute('aria-label')).toBe(
    '描述你想生成的图片',
  )
  click('[data-node-id="image"]')
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.studio-node-pick-banner')).toBeNull()
})

it('places a popular script brief from the blank canvas menu', async () => {
  await render()
  const surface = host.querySelector('.react-flow')!
  await act(async () =>
    surface.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: 240, clientY: 180 }),
    ),
  )
  const clickText = (text: string) =>
    [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!
  await act(async () => clickText('剧本设定').click())
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('题材')
  await act(async () => clickText('山海学徒').click())
  await act(async () => clickText('生成文本节点').click())
  const script = readCanvasDocument(canvas.doc).nodes.find((node) => node.type === 'text')
  expect(script?.type).toBe('text')
  if (script?.type === 'text') {
    expect(script.data.name).toBe('山海学徒')
    expect(script.data.text).toContain('## 大纲')
    expect(script.data.text).toContain('## 人物表')
    expect(script.data.text).toContain('阿禾')
    expect(script.data.text).toContain('## 第 1 集')
  }
  expect(document.querySelector('[role=dialog]')).toBeNull()
})

it('shows the prompt composer only for a selected node', async () => {
  await render()
  expect(host.querySelector('.studio-node-composer')).toBeNull()
  act(() => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
  expect(host.querySelector('.studio-node-composer')).not.toBeNull()
})

it.each(
  IMAGE_PRESETS,
)('prepares $skillName with its source reference and only generates on Send', async (preset) => {
  const params = useStore.getState().params
  useStore.setState({ params: { ...params, n: 3 } })
  try {
    await render()
    await act(async () => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
    const original = structuredClone(readCanvasDocument(canvas.doc).nodes[0])
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="预设"]')!.click())
    const title = i18next.t(`imagePresets.${preset.skillName}.title`, { ns: 'canvas' })
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.includes(title),
    )!
    expect(choice).toBeTruthy()
    await act(async () => choice.click())
    const snapshot = readCanvasDocument(canvas.doc)
    const result = snapshot.nodes.find((node) => node.id !== 'image')!
    expect(snapshot.nodes.find((node) => node.id === 'image')).toEqual(original)
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({ source: 'image', target: result.id }),
    )
    expect(host.querySelector('[data-skill-name]')?.textContent).toContain(title)
    expect(mocks.submitImage).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.click())
    expect(mocks.submitImage).toHaveBeenCalledWith(
      expect.anything(),
      canvas.doc,
      result.id,
      expect.stringContaining(preset.instruction),
      ['data:image/png;base64,AA=='],
      undefined,
      undefined,
      expect.objectContaining({ params: expect.objectContaining({ n: 1 }) }),
    )
    expect(useStore.getState().params.n).toBe(3)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除预设"]')!.click())
    expect(host.querySelector('[data-skill-name]')).toBeNull()
    expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  } finally {
    useStore.setState({ params })
  }
})

it('sends a preset template through the selected image node', async () => {
  const params = useStore.getState().params
  const settings = useStore.getState().settings
  const noteLookUsed = useLibraryStore.getState().noteLookUsed
  setChannels([
    {
      id: 'platform',
      kind: 'openai-queue',
      label: 'Platform',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  const profile = createBuiltinEdgeProfile('platform', 'gpt-image-2')
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    }),
  })
  const look: LookRecord = {
    id: 'amber',
    name: '暖光窗台',
    description: '暖光商品图',
    purpose: 'hero',
    body: '暖光商品图\n',
    model: profile.selectedModelId,
    size: '1024x1024',
    slotCount: 1,
    referenceImageIds: [],
    coverImageId: null,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  }
  const asset: AssetRecord = {
    id: 'cup-asset',
    name: '茶杯',
    kind: 'product',
    views: [{ imageId: 'cup', label: 'front', source: 'upload' }],
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  }
  useLibraryStore.setState({
    looks: [look],
    assets: [asset],
    noteLookUsed: async () => {},
  })
  old.files = { ...old.files, cup: 'data:image/png;base64,CUP' }
  insertCanvasNode(
    canvas.doc,
    {
      id: 'cup',
      type: 'image',
      x: 220,
      y: 20,
      width: 100,
      height: 100,
      data: { fileId: 'cup', name: '茶杯', meta: { nodeKind: 'asset' } },
    },
    canvas.origin,
  )
  connectCanvasNodes(canvas.doc, { source: 'cup', target: 'image' }, canvas.origin)
  try {
    await render()
    await act(async () => host.querySelector<HTMLElement>('[data-node-id="image"]')!.click())
    const chip = [...host.querySelectorAll<HTMLButtonElement>('[data-look-chips] button')].find(
      (button) => button.textContent?.includes('暖光窗台'),
    )
    expect(chip).toBeTruthy()
    await act(async () => chip!.click())
    expect(host.querySelector('[data-look-capsule]')?.textContent).toContain('暖光窗台')
    const input = host.querySelector(
      'textarea[aria-label="描述你想生成的图片"]',
    ) as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '再亮一点')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.getAttribute('aria-label') === '生成')!
        .click(),
    )
    expect(mocks.submitImage).toHaveBeenCalledWith(
      expect.anything(),
      canvas.doc,
      'image',
      '暖光商品图\n\n输入 1 = 素材「茶杯」\n\n再亮一点',
      ['data:image/png;base64,CUP'],
      undefined,
      undefined,
      expect.objectContaining({
        params: expect.objectContaining({ size: '1024x1024' }),
      }),
    )
  } finally {
    useActiveLook.getState().set(null)
    useLibraryStore.setState({ looks: [], assets: [], noteLookUsed })
    useStore.setState({ params, settings })
    resetChannelCatalog()
  }
})
