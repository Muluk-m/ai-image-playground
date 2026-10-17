// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasGroup,
  deleteCanvasNode,
  insertCanvasNode,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { captureTurnSubmission } from '../../../../features/agent/lib/turnSubmission'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import {
  clearNodeCanvasSelection,
  setNodeCanvasSelection,
} from '../../../../features/canvas/lib/nodeCanvasSelection'
import type { CanvasProject } from '../../../../features/canvas/lib/projectRepository'

const workspace = vi.hoisted(() => ({
  editor: {} as CanvasEditor,
  cloud: undefined as { canvas: object; sync: () => Promise<void> } | undefined,
  record: { key: 'scene', getSnapshot: () => ({ loading: false, loadFailed: false }) },
  doc: { elements: [], files: {} },
}))
vi.mock('../../../../features/canvas/lib/activeProject', () => ({
  peekCanvasWorkspace: () => workspace,
}))
vi.mock('../../../../features/canvas/lib/canvasSnapshot', () => ({
  liveCanvasSnapshot: () => ({ elements: [] }),
}))

const project: CanvasProject = {
  id: 'project',
  name: 'Chat',
  customName: true,
  conversationId: 'conversation',
  sceneKey: 'scene',
  createdAt: 0,
  updatedAt: 0,
  hasContent: true,
  kind: 'image',
  experience: 'chat',
}

it('does not attach a hidden canvas to a chat message or replay', async () => {
  const references = [{ imageId: 'attached', dataUrl: 'data:image/png;base64,aGk=' }]
  for (const replay of [
    undefined,
    { canvas: { elements: [] }, canvasReferenceIds: ['attached'] },
  ]) {
    const captured = captureTurnSubmission({
      project,
      conversationId: 'conversation',
      references,
      params: {},
      replay,
    })
    expect(captured.snapshot.canvas).toBeUndefined()
    expect((await captured.prepare())?.canvas).toBeUndefined()
    expect(captured.snapshot.references).toEqual(references)
    expect(captured.snapshot.canvasReferenceIds).toEqual([])
  }
})

it('continues attaching the live canvas for canvas projects', () => {
  const captured = captureTurnSubmission({
    project: { ...project, experience: 'canvas' },
    conversationId: 'conversation',
    references: [],
    params: {},
  })
  expect(captured.snapshot.canvas).toEqual({ elements: [] })
})

it('records the experience the message was sent from, even while the canvas is loading', async () => {
  const legacy = { ...project, conversationId: null, experience: undefined }
  const loading = vi.spyOn(workspace.record, 'getSnapshot')
  loading.mockReturnValue({ loading: true, loadFailed: false })
  try {
    const captured = captureTurnSubmission({
      project: legacy,
      conversationId: null,
      references: [],
      params: {},
    })
    // 画布没读完带不了快照，但入口照样说清楚。
    expect(captured.snapshot.canvas).toBeUndefined()
    expect(captured.snapshot.experience).toBe('canvas')
    expect((await captured.prepare())?.experience).toBe('canvas')
  } finally {
    loading.mockRestore()
  }
})

it('keeps the experience a replayed message was originally sent from', () => {
  const captured = captureTurnSubmission({
    project,
    conversationId: 'conversation',
    references: [],
    params: {},
    replay: { experience: 'canvas' },
  })
  expect(captured.snapshot.experience).toBe('canvas')
})

it('freezes the node selection for a turn and waits for its cloud sync', async () => {
  const editor = new CanvasEditor(new CanvasDoc())
  workspace.editor = editor
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'reference-test')
  const canvas = { doc } as NodeCanvasDocument
  for (const id of ['node', 'other']) {
    insertCanvasNode(
      doc,
      {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        data: { text: id, fontSize: 16, fill: '#fff' },
      },
      origin,
    )
  }
  createCanvasGroup(doc, 'group', ['node'], 'Scene', origin)
  const sync = vi.fn(async () => {})
  workspace.cloud = { canvas: {}, sync }
  setNodeCanvasSelection(editor, canvas, ['group', 'node'])
  try {
    const captured = captureTurnSubmission({
      project: { ...project, experience: 'canvas' },
      conversationId: 'conversation',
      references: [],
      params: {},
    })
    setNodeCanvasSelection(editor, canvas, ['other'])
    expect((await captured.prepare())?.canvas?.selectedNodeIds).toEqual(['group', 'node'])
    expect(sync).toHaveBeenCalledOnce()
    sync.mockRejectedValueOnce(new Error('offline'))
    await expect(captured.prepare()).rejects.toThrow('offline')
    deleteCanvasNode(doc, 'other', origin)
    const next = captureTurnSubmission({
      project: { ...project, experience: 'canvas' },
      conversationId: 'conversation',
      references: [],
      params: {},
    })
    expect(next.snapshot.canvas?.selectedNodeIds).toEqual([])
    expect(captured.snapshot.canvas?.selectedNodeIds).toEqual(['group', 'node'])
  } finally {
    clearNodeCanvasSelection(editor, canvas)
    doc.destroy()
    workspace.cloud = undefined
  }
})
