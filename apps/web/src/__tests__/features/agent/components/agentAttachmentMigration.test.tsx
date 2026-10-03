// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DraftSession } from '../../../../features/agent/lib/drafts'
import { scopedStorageName, setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { readLocalAttachment } from '../../../../lib/localAttachmentSources'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

it('migrates restored legacy drafts and replay snapshots to shared local originals without changing their command identity', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    return Response.json({
      'agent:attachments': true,
      'agent:bulk-attachments': true,
      attachmentLimits: {
        logicalReferences: 100,
        imageBytes: 10 * 1024 * 1024,
        imagePixels: 40_000_000,
        uploadConcurrency: 4,
      },
    })
  })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  const open = indexedDB.open('image-playground-agent-drafts', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('drafts')
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  const original = `data:image/png;base64,${btoa('legacy-original')}`
  const mask = `data:image/png;base64,${btoa('legacy-mask')}`
  const key = scopedStorageName(`agent-project-draft:${crypto.randomUUID()}`)
  const commandId = crypto.randomUUID()
  const legacy = {
    prompt: 'original prompt',
    references: [{ id: 'photo', dataUrl: original, maskDataUrl: mask, name: 'photo' }],
    submission: {
      id: commandId,
      text: 'original prompt',
      mode: 'image',
      clarificationAnswer: false,
      references: [{ imageId: 'photo', dataUrl: original, maskDataUrl: mask }],
    },
    remainingUnsent: [{ prompt: 'next prompt', references: [{ id: 'photo', dataUrl: original }] }],
  }
  const write = db.transaction('drafts', 'readwrite')
  write.objectStore('drafts').put(legacy, key)
  await new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve()
    write.onabort = () => reject(write.error)
  })
  try {
    const session = new DraftSession(key)
    await session.ready
    const recovered = session.getSnapshot().unsent!
    expect(recovered.references[0]!.dataUrl).toMatch(/^aip-local:/)
    expect(recovered.submission?.id).toBe(commandId)
    expect(recovered.submission?.references[0]).toMatchObject({
      dataUrl: recovered.references[0]!.dataUrl,
      maskDataUrl: recovered.references[0]!.maskDataUrl,
    })
    expect(
      new TextDecoder().decode((await readLocalAttachment(recovered.references[0]!.dataUrl)).data),
    ).toBe('legacy-original')
    await session.flush()
    const read = db.transaction('drafts').objectStore('drafts').get(key)
    const stored = await new Promise<typeof legacy>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    expect(JSON.stringify(stored)).not.toContain('base64,')
    session.restoreUnsent()
    expect(session.getSnapshot().draft.submission?.id).toBe(commandId)
    session.discardUnsent()
    session.update({ prompt: '', references: [] })
    await session.flush()
  } finally {
    db.close()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})
