// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import {
  discardPendingSubmission,
  hasPendingSubmission,
  pendingSubmissionId,
  queuePendingSubmission,
  takePendingSubmission,
} from '../../auth/pendingSubmission'

const draft = { kind: 'heroCanvas' as const, draft: { prompt: 'original', references: [] } }
afterEach(async () => {
  await discardPendingSubmission()
  sessionStorage.clear()
})

it('consumes a frozen intent exactly once across concurrent remounts', async () => {
  await queuePendingSubmission(draft)
  const results = await Promise.all([takePendingSubmission(), takePendingSubmission()])
  expect(results.filter(Boolean)).toEqual([draft])
  expect(await hasPendingSubmission()).toBe(false)
})

it('cancellation invalidates an in-flight write before it can resume', async () => {
  const writing = queuePendingSubmission(draft, 'old')
  await discardPendingSubmission('old')
  await writing
  expect(await takePendingSubmission()).toBeUndefined()
})

it('old cancellation does not erase a newer pending intent', async () => {
  await queuePendingSubmission(draft, 'old')
  const next = { ...draft, draft: { ...draft.draft, prompt: 'next' } }
  await queuePendingSubmission(next, 'new')
  await discardPendingSubmission('old')
  expect(pendingSubmissionId()).toBe('new')
  expect(await takePendingSubmission()).toEqual(next)
})

it('cancellation during the atomic read prevents a late resume', async () => {
  await queuePendingSubmission(draft, 'old')
  const taking = takePendingSubmission()
  await discardPendingSubmission('old')
  expect(await taking).toBeUndefined()
})
