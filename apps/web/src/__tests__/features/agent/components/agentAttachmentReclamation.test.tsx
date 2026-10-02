// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'

it('rebuilds original ownership from durable draft and outgoing documents before reclaiming crashed intake and sending owners', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const held = new Set<string>()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        name: string,
        options: LockOptions | LockGrantedCallback<unknown>,
        callback?: LockGrantedCallback<unknown>,
      ) => {
        const run = typeof options === 'function' ? options : callback!
        if (held.has(name)) return run(null)
        held.add(name)
        try {
          return await run({ name, mode: 'exclusive' } as Lock)
        } finally {
          held.delete(name)
        }
      },
    },
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
  })
  const user = crypto.randomUUID()
  const { scopedStorageName, setClientStorageScope } = await import('../../../../lib/authScope')
  setClientStorageScope(user)
  const { DraftSession } = await import('../../../../features/agent/lib/drafts')
  const { rememberOutgoing } = await import('../../../../features/agent/lib/outgoingJournal')
  const { registerLocalAttachmentSource, readLocalAttachment, attachmentSourceOwner } =
    await import('../../../../lib/localAttachmentSources')
  const { BASE_DB_NAME, openNamedDb, STORE_ATTACHMENT_METADATA, STORE_ATTACHMENT_OWNERS } =
    await import('../../../../lib/db')
  const source = (text: string) =>
    registerLocalAttachmentSource(`data:image/png;base64,${btoa(text)}`, 1024)
  const draftSource = source('draft-original')
  const outgoingSource = source('outgoing-original')
  const orphan = source('uncommitted-intake')
  const sending = source('crashed-sending')
  await Promise.all([draftSource, outgoingSource, orphan, sending].map(readLocalAttachment))
  const key = scopedStorageName(`agent-project-draft:${crypto.randomUUID()}`)
  const session = new DraftSession(key)
  await session.ready
  session.update({ prompt: 'keep draft', references: [{ id: 'photo', dataUrl: draftSource }] })
  await session.flush()
  await rememberOutgoing({
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    conversationId: null,
    text: 'keep command',
    mode: 'image',
    clarificationAnswer: false,
    createdAt: Date.now(),
    references: [{ imageId: 'photo', dataUrl: outgoingSource }],
  })
  await attachmentSourceOwner(`sending:${crypto.randomUUID()}`).retain({
    references: [{ dataUrl: sending }],
  })
  // Simulate a crash with a stale/missing index: documents remain the source of truth.
  const db = await openNamedDb(scopedStorageName(BASE_DB_NAME))
  const tx = db.transaction([STORE_ATTACHMENT_METADATA, STORE_ATTACHMENT_OWNERS], 'readwrite')
  tx.objectStore(STORE_ATTACHMENT_OWNERS).delete(`draft:${key}`)
  const read = tx.objectStore(STORE_ATTACHMENT_METADATA).get(draftSource.slice('aip-local:'.length))
  read.onsuccess = () =>
    tx.objectStore(STORE_ATTACHMENT_METADATA).put({ ...read.result, owners: [] })
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  held.clear() // Browser releases this page's Web Locks on termination.
  vi.resetModules()
  const auth = await import('../../../../lib/authScope')
  auth.setClientStorageScope(user)
  const restartedDrafts = await import('../../../../features/agent/lib/drafts')
  const restartedSources = await import('../../../../lib/localAttachmentSources')
  try {
    const restored = new restartedDrafts.DraftSession(key)
    await restored.ready
    expect(restored.getSnapshot().unsent?.references[0]?.dataUrl).toBe(draftSource)
    expect(
      new TextDecoder().decode((await restartedSources.readLocalAttachment(draftSource)).data),
    ).toBe('draft-original')
    expect(
      new TextDecoder().decode((await restartedSources.readLocalAttachment(outgoingSource)).data),
    ).toBe('outgoing-original')
    await expect(restartedSources.readLocalAttachment(orphan)).rejects.toThrow(
      'attachment_source_missing',
    )
    await expect(restartedSources.readLocalAttachment(sending)).rejects.toThrow(
      'attachment_source_missing',
    )
  } finally {
    auth.setClientStorageScope(null)
    delete (navigator as { locks?: LockManager }).locks
    vi.unstubAllGlobals()
  }
})
