import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireRefreshAttempt,
  clearRefreshJournal,
  completeRefreshAttempt,
} from '../../lib/sessionRefreshJournal'

describe('durable web refresh identity', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
  afterEach(() => vi.unstubAllGlobals())

  it('atomically shares one pending identity across independent tabs without Web Locks', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => acquireRefreshAttempt('https://api.example.com')),
    )
    expect(new Set(attempts.map((attempt) => attempt.requestKey)).size).toBe(1)
    expect((await acquireRefreshAttempt('https://other.example.com')).requestKey).not.toBe(
      attempts[0]?.requestKey,
    )
  })

  it('never lets an old completion delete a newer pending operation', async () => {
    const scope = 'https://api.example.com'
    const first = await acquireRefreshAttempt(scope)
    await completeRefreshAttempt(scope, first.requestKey)
    const next = await acquireRefreshAttempt(scope)
    await completeRefreshAttempt(scope, first.requestKey)
    expect(await acquireRefreshAttempt(scope)).toEqual(next)
    expect(next.previousKey).toBe(first.requestKey)
    await clearRefreshJournal(scope)
    expect((await acquireRefreshAttempt(scope)).requestKey).not.toBe(next.requestKey)
  })
})
