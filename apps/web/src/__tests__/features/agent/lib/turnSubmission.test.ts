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
