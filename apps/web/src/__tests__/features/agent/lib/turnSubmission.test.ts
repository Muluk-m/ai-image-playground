// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { captureTurnSubmission } from '../../../../features/agent/lib/turnSubmission'
import type { CanvasProject } from '../../../../features/canvas/lib/projectRepository'

const workspace = vi.hoisted(() => ({
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
