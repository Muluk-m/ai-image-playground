import { afterEach, describe, expect, it } from 'bun:test'
import { OpsStorageError } from '../../lib/ops-storage-error'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:5432/unused'
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
// The module import must happen after the test environment is initialized.
const { readBackups, readRestoreDrill } = await import('../../lib/ops-backups')
const drillKey = 'pg/drill/latest.json'
const drillEntry = { key: drillKey, size: 1, lastModified: 123 }
const secret = 'fixture-private-credential'
const failure = Object.assign(new Error(`https://store.invalid/file?signature=${secret}`), {
  code: 'Unauthorized',
  status: 401,
  cause: Object.assign(new Error(`Authorization: Bearer ${secret}`), {
    code: 'SignatureDoesNotMatch',
  }),
})

async function rejected(read: () => Promise<unknown>): Promise<OpsStorageError> {
  try {
    await read()
  } catch (error) {
    expect(error).toBeInstanceOf(OpsStorageError)
    return error as OpsStorageError
  }
  throw new Error('Expected storage observation to fail')
}

describe('storage observation diagnostics', () => {
  afterEach(() => setObjectStoreForTesting())

  it('keeps only safe storage failure fields', () => {
    const error = new OpsStorageError('list', failure)
    expect(error.storageError).toEqual({
      code: 'Unauthorized',
      status: 401,
      reason: 'details_omitted',
      cause: { code: 'SignatureDoesNotMatch', reason: 'details_omitted' },
    })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(error.message).not.toContain(secret)
  })

  it('identifies listing failures', async () => {
    const store = new InMemoryObjectStore()
    store.listEntries = async () => {
      throw failure
    }
    setObjectStoreForTesting(store)
    expect((await rejected(readBackups)).stage).toBe('list')
    expect((await rejected(readRestoreDrill)).stage).toBe('list')
  })

  it('identifies a drill result read failure separately from listing', async () => {
    const store = new InMemoryObjectStore()
    store.listEntries = async () => [drillEntry]
    store.read = async () => {
      throw failure
    }
    setObjectStoreForTesting(store)
    expect((await rejected(readRestoreDrill)).stage).toBe('read')
  })
})
