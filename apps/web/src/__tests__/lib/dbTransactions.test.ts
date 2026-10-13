// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { dbTransaction, getAllImages, getCachedMedia, STORE_MEDIA, storeImage } from '../../lib/db'

it('rejects when a successful write request is followed by a transaction abort', async () => {
  setClientStorageScope('transaction-commit-before-success')
  const id = 'aborted-preview'
  let requestSucceeded = false
  try {
    await expect(
      dbTransaction(STORE_MEDIA, 'readwrite', (store) => {
        const request = store.put({ id, bytes: 3, data: Uint8Array.from([1, 2, 3]).buffer })
        request.addEventListener('success', () => {
          requestSucceeded = true
          store.transaction.abort()
        })
        return request
      }),
    ).rejects.toThrow('storage_transaction_aborted')
    expect(requestSucceeded).toBe(true)
    expect(await getCachedMedia(id)).toBeUndefined()
    await expect(
      dbTransaction(STORE_MEDIA, 'readwrite', (store) => store.put({ id })),
    ).resolves.toBe(id)
    expect(await getCachedMedia(id)).toMatchObject({ id })
  } finally {
    setClientStorageScope(null)
  }
})

it('does not store the previous account image after switching accounts during thumbnail decoding', async () => {
  const decoding: Array<{ onerror?: () => void }> = []
  vi.stubGlobal(
    'Image',
    class {
      onerror?: () => void
      src = ''
      constructor() {
        decoding.push(this)
      }
    },
  )
  setClientStorageScope('candidate-old-account')
  try {
    const storing = storeImage('data:image/png;base64,aGVsbG8=', 'generated').catch(
      (error) => error,
    )
    await vi.waitFor(() => expect(decoding).toHaveLength(1))
    setClientStorageScope('candidate-new-account')
    decoding[0]!.onerror!()
    expect((await storing).message).toBe('account_changed')
    expect(await getAllImages()).toEqual([])
    setClientStorageScope('candidate-old-account')
    expect(await getAllImages()).toEqual([])
  } finally {
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})
