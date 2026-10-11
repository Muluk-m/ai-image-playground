import type { CloudProjectSummary } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { catalogProjectId, projectCatalog } from '../../../../features/canvas/lib/projectCatalog'
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

const cloudChat: CanvasProject = { ...local, cloud: { revision: 1 } }
const legacyChat: CanvasProject = {
  ...local,
  id: 'legacy:canvas:conversation:c1',
  sceneKey: 'canvas:conversation:c1',
  updatedAt: 300,
}

describe('conversation catalog identity', () => {
  it('lists the cloud chat once while retaining the legacy record and its active identity', () => {
    const projects = [legacyChat, cloudChat]
    expect(projectCatalog(projects, {})).toEqual([cloudChat])
    expect(catalogProjectId(legacyChat, projects)).toBe(cloudChat.id)
    expect(projects).toEqual([legacyChat, cloudChat])
    expect(projectCatalog([{ ...legacyChat, cloud: { revision: 0 } }, cloudChat], {})).toEqual([
      cloudChat,
    ])
  })

  it('keeps unrelated chats with identical names and canvas projects linked to the conversation', () => {
    const separateChat = { ...cloudChat, id: 'p2', conversationId: 'c2' }
    const canvas = { ...cloudChat, id: 'canvas', experience: 'canvas' as const }
    expect(projectCatalog([legacyChat, cloudChat, separateChat, canvas], {})).toEqual([
      cloudChat,
      separateChat,
      canvas,
    ])
  })

  it('keeps a legacy chat available when the cloud project is missing or deleted', () => {
    expect(projectCatalog([legacyChat], {})).toEqual([legacyChat])
    const deleted = { ...cloudChat, cloud: { revision: 1, deleted: true } }
    expect(projectCatalog([legacyChat, deleted], {})).toEqual([legacyChat])
    expect(catalogProjectId(legacyChat, [legacyChat, deleted])).toBe(legacyChat.id)
  })

  it('does not hide independently created projects sharing a conversation', () => {
    const independent = { ...local, id: 'local-project' }
    expect(projectCatalog([independent, cloudChat], {})).toEqual([independent, cloudChat])
  })
})
