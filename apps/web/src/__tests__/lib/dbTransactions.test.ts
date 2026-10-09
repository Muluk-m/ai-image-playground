// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { dbTransaction, getCachedMedia, STORE_MEDIA } from '../../lib/db'

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
