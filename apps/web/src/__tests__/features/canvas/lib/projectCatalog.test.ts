import type { CloudProjectSummary } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { projectCatalog } from '../../../../features/canvas/lib/projectCatalog'
import type { CanvasProject } from '../../../../features/canvas/lib/projectRepository'

const local: CanvasProject = {
  id: 'p1',
  name: 'chat',
  customName: false,
  conversationId: 'c1',
  sceneKey: 'p1',
  createdAt: 1,
  updatedAt: 200,
  hasContent: true,
  kind: 'image',
  experience: 'chat',
}

const remote: CloudProjectSummary = {
  id: 'p1',
  name: 'chat',
  revision: 1,
  createdAt: 1,
  updatedAt: 100,
  elementCount: 0,
  coverMediaId: 'generated',
  conversationId: 'c1',
  experience: 'chat',
}

describe('projectCatalog cover', () => {
  it('uses the cloud cover when the newer local copy has none', () => {
    expect(projectCatalog([local], { p1: remote })[0]?.cover).toBe('aip-media:generated')
  })

  it('keeps a newer local cover over the cloud one', () => {
    expect(projectCatalog([{ ...local, cover: 'data:local' }], { p1: remote })[0]?.cover).toBe(
      'data:local',
    )
  })
})
