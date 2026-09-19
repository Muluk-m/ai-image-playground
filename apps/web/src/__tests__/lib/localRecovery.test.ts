// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CONVERSATION_KEY,
  scopedStorageName,
  setClientStorageScope,
  setRecoveryBackend,
} from '../../lib/authScope'
import { recoverStorageUser, rememberStorageUser } from '../../lib/localRecovery'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  setClientStorageScope(null)
  setRecoveryBackend(null)
})

describe('local fallback continuity', () => {
  it('recovers the only existing user without moving or overwriting their settings', async () => {
    localStorage.setItem('image-playground:user-alice', 'saved-work')
    localStorage.setItem('image-playground', 'anonymous-work')
    expect(await recoverStorageUser()).toBe('alice')
    expect(localStorage.getItem('image-playground:user-alice')).toBe('saved-work')
    expect(localStorage.getItem('image-playground')).toBe('anonymous-work')
  })
  it('does not guess between accounts and honors explicit logout', async () => {
    localStorage.setItem('image-playground:user-alice', '{}')
    localStorage.setItem('image-playground:user-bob', '{}')
    await expect(recoverStorageUser()).rejects.toThrow('Multiple local accounts')
    rememberStorageUser('bob')
    expect(await recoverStorageUser()).toBe('bob')
    rememberStorageUser(null)
    expect(await recoverStorageUser()).toBeNull()
  })
  it('isolates fallback conversations while keeping canvas and history in the original scope', () => {
    setClientStorageScope('alice')
    const original = scopedStorageName(AGENT_CONVERSATION_KEY)
    setRecoveryBackend('https://backup.example.com')
    expect(scopedStorageName(AGENT_CONVERSATION_KEY)).not.toBe(original)
    expect(scopedStorageName('canvas')).toBe('canvas:user-alice')
    expect(scopedStorageName('image-playground')).toBe('image-playground:user-alice')
    setRecoveryBackend(null)
    expect(scopedStorageName(AGENT_CONVERSATION_KEY)).toBe(original)
  })
})

it('preserves the production conversation binding when a fallback conversation is saved', async () => {
  vi.resetModules()
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const { projectRepository } = await import('../../features/canvas/lib/projectRepository')
  const scope = await import('../../lib/authScope')
  scope.setClientStorageScope('alice')
  const project = await projectRepository.create('existing canvas', {
    sceneKey: 'saved-scene',
    conversationId: 'production-conversation',
  })
  scope.setRecoveryBackend('https://backup.example.com')
  expect((await projectRepository.list())[0]?.conversationId).toBeNull()
  await projectRepository.update(project.id, {
    conversationId: 'backup-conversation',
    name: 'edited title',
  })
  expect((await projectRepository.list())[0]?.conversationId).toBe('backup-conversation')
  expect((await projectRepository.list())[0]?.sceneKey).toBe('saved-scene')
  scope.setRecoveryBackend(null)
  expect((await projectRepository.list())[0]?.conversationId).toBe('production-conversation')
  expect((await projectRepository.list())[0]?.name).toBe('edited title')
})
