import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ObjectStore } from '../../lib/objectStore'
import { OpsStorageError } from '../../lib/ops-storage-error'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

let initialize: () => ObjectStore = () => new InMemoryObjectStore()
mock.module('../../lib/objectStore', () => ({ objectStore: () => initialize() }))
const { readBackups, readRestoreDrill } = await import('../../lib/ops-backups')
afterEach(() => {
  initialize = () => new InMemoryObjectStore()
})

const key = 'pg/drill/latest.json'
const entry = { key, size: 1, lastModified: 123 }
const secret = 'fixture-private-credential'
const failure = Object.assign(new Error(`https://store.invalid/file?X-Amz-Signature=${secret}`), {
  code: 'InternalError',
  status: 503,
  path: secret,
  request: { authorization: secret },
  body: secret,
  cause: Object.assign(new Error(`Authorization: Bearer ${secret}`), { code: 'ECONNRESET' }),
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
  for (const read of [readBackups, readRestoreDrill]) {
    it(`${read.name} identifies initialization failure without exposing source data`, async () => {
      initialize = () => {
        throw failure
      }
      const error = await rejected(read)
      expect(error.stage).toBe('initialize')
      expect(error.storageError).toEqual({
        code: 'InternalError',
        status: 503,
        reason: 'details_omitted',
        cause: { code: 'ECONNRESET', reason: 'details_omitted' },
      })
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(error.message).not.toContain(secret)
      expect(error.cause).toBeUndefined()
    })

    it(`${read.name} identifies listing failure and does not read object contents`, async () => {
      const store = new InMemoryObjectStore()
      const reads: string[] = []
      store.listEntries = async (prefix) => {
        expect(prefix).toBe(read === readBackups ? 'pg/' : key)
        throw failure
      }
      store.read = async (requested) => {
        reads.push(requested)
        return new Uint8Array()
      }
      initialize = () => store
      expect((await rejected(read)).stage).toBe('list')
      expect(reads).toEqual([])
    })
  }

  it('identifies the read failure after finding the drill result', async () => {
    const store = new InMemoryObjectStore()
    store.listEntries = async () => [entry]
    store.read = async (requested) => {
      expect(requested).toBe(key)
      throw failure
    }
    initialize = () => store
    const error = await rejected(readRestoreDrill)
    expect(error.stage).toBe('read')
    expect(error.storageError.status).toBe(503)
  })

  it('keeps absent, valid and malformed drill results distinct', async () => {
    const store = new InMemoryObjectStore()
    initialize = () => store
    expect(await readRestoreDrill()).toBeNull()
    store.listEntries = async () => [entry]
    await store.write(key, new TextEncoder().encode('{invalid'), 'application/json')
    expect(await readRestoreDrill()).toEqual({
      ok: false,
      finished_at: 123,
      error: '演练结果文件无法解析',
    })
    await store.write(
      key,
      new TextEncoder().encode(JSON.stringify({ ok: true, finished_at: '2026-10-29T00:00:00Z' })),
      'application/json',
    )
    expect(await readRestoreDrill()).toEqual({
      ok: true,
      finished_at: Date.parse('2026-10-29T00:00:00Z'),
      error: null,
    })
  })

  it('keeps known generic reasons and bounded, safe causes only', () => {
    const source = Object.assign(new Error('an unexpected error has occurred'), {
      code: secret,
      status: secret,
      statusCode: 500,
      cause: Object.assign(new Error('We encountered an internal error. Please try again.'), {
        code: 'InternalError',
      }),
    })
    Object.assign(source.cause, { cause: source })
    expect(new OpsStorageError('list', source).storageError).toEqual({
      status: 500,
      reason: 'unexpected_error',
      cause: { code: 'InternalError', reason: 'internal_error' },
    })
    const nested = { cause: { cause: { cause: { code: 'AccessDenied' } } } }
    expect(JSON.stringify(new OpsStorageError('read', nested))).not.toContain('AccessDenied')
    expect(new OpsStorageError('read', secret).storageError).toEqual({ reason: 'details_omitted' })
    expect(new OpsStorageError('read', { status: 999, code: secret }).storageError).toEqual({
      reason: 'details_omitted',
    })
    expect(
      new OpsStorageError('read', {
        get code() {
          throw new Error(secret)
        },
      }).storageError,
    ).toEqual({ reason: 'details_omitted' })
  })
})
