// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  insertCanvasNode,
  readCanvasDocument,
  updateStoryboardShot,
} from '@image-playground/shared'
import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeStoryboard, {
  NodeStoryboardContext,
} from '../../../../features/canvas/components/NodeStoryboard'
import { chooseOption, stubPointerApis } from '../../../helpers/radix'

vi.mock('../../../../features/canvas/components/NodePorts', () => ({ default: () => null }))
vi.mock('../../../../store', () => ({
  useStore: (select: (state: unknown) => unknown) => select({ settings: {} }),
}))
vi.mock('../../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({}),
  clientProfileToApiProfile: () => ({ model: 'fixture' }),
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, estimatedCredits: 12 }),
}))
afterEach(() => {
  document.body.innerHTML = ''
})
it('edits live fields, confirms only the reviewed batch, and invalidates confirmation on later changes', async () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  insertCanvasNode(
    doc,
    {
      id: 'board',
      type: 'storyboard',
      x: 0,
      y: 0,
      width: 640,
      height: 340,
      data: {
        shots: [
          { id: 'a', description: 'first scene', lookIds: [] },
          { id: 'b', description: 'second scene', lookIds: [] },
        ],
      },
    },
    origin,
  )
  for (const [id, assetKind] of [
    ['person', 'person'],
    ['location', 'location'],
  ] as const)
    insertCanvasNode(
      doc,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 300,
        height: 240,
        data: { name: id, meta: { nodeKind: 'asset', assetKind } },
      },
      origin,
    )
  const canvas = { doc, origin, undo, destroy: async () => {} }
  function Harness() {
    const [snapshot, setSnapshot] = useState(() => readCanvasDocument(doc))
    useEffect(() => {
      const update = () => setSnapshot(readCanvasDocument(doc))
      doc.on('update', update)
      return () => doc.off('update', update)
    }, [])
    const node = snapshot.nodes[0]!
    return node.type === 'storyboard' ? (
      <NodeStoryboardContext.Provider value={{ canvas, snapshot }}>
        <NodeStoryboard node={node} />
      </NodeStoryboardContext.Provider>
    ) : null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
  await act(async () => root.render(<Harness />))
  await act(async () => button('编辑分镜').click())
  expect(document.querySelector('[role=dialog]')).not.toBeNull()
  stubPointerApis()
  chooseOption('@ 人物', 'person')
  chooseOption('@ 地点', 'location')
  expect(
    readCanvasDocument(doc)
      .edges.map((edge) => edge.source)
      .sort(),
  ).toEqual(['location', 'person'])
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="第 1 镜后移"]')!.click(),
  )
  let board = readCanvasDocument(doc).nodes.find((n) => n.id === 'board')!
  expect(board.type === 'storyboard' && board.data.shots.map((shot) => shot.id)).toEqual(['b', 'a'])
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="删除第 2 镜"]')!.click(),
  )
  expect(readCanvasDocument(doc).edges).toEqual([])
  await act(async () => undo.undo())
  expect(readCanvasDocument(doc).edges).toHaveLength(2)
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="第 2 镜前移"]')!.click(),
  )
  const field = document.querySelector('textarea')!
  await act(async () => field.focus())
  // A remote update while this field is focused must survive an unchanged blur.
  await act(async () =>
    updateStoryboardShot(
      doc,
      'board',
      'a',
      { description: 'remote scene' },
      canvasOrigin('user', 'other'),
    ),
  )
  await act(async () => field.blur())
  expect(field.value).toBe('remote scene')
  await act(async () => button('定稿').click())
  expect(document.body.textContent).toContain('fixture')
  expect(document.body.textContent).toContain('12')
  await act(async () =>
    updateStoryboardShot(
      doc,
      'board',
      'a',
      { description: 'new scene' },
      canvasOrigin('user', 'other'),
    ),
  )
  expect(button('确认定稿').disabled).toBe(true)
  await act(async () => button('取消').click())
  await act(async () => button('定稿').click())
  await act(async () => button('确认定稿').click())
  let node = readCanvasDocument(doc).nodes[0]!
  expect(node.type === 'storyboard' && node.data.confirmed?.quantity).toBe(2)
  await act(async () =>
    updateStoryboardShot(
      doc,
      'board',
      'a',
      { description: 'third revision' },
      canvasOrigin('user', 'other'),
    ),
  )
  expect(button('定稿').disabled).toBe(false)
  await act(async () => {
    field.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      'saved on escape',
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(document.querySelector('[role=dialog]')).toBeNull()
  node = readCanvasDocument(doc).nodes[0]!
  expect(node.type === 'storyboard' && node.data.shots[0]!.description).toBe('saved on escape')
  await act(async () => root.unmount())
  undo.destroy()
  doc.destroy()
})
