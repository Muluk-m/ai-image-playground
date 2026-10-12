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

it('keeps video settings with the interrupted login intent', async () => {
  const videoDraft = {
    model: 'grok-imagine-video-1.5-lite',
    duration: 10 as const,
    aspectRatio: '9:16' as const,
    resolution: '480p' as const,
  }
  const pending = { ...draft, mode: 'video' as const, videoDraft }
  await queuePendingSubmission(pending)
  videoDraft.model = 'changed-after-send'
  expect(await takePendingSubmission()).toMatchObject({
    mode: 'video',
    videoDraft: {
      model: 'grok-imagine-video-1.5-lite',
      duration: 10,
      aspectRatio: '9:16',
      resolution: '480p',
    },
  })
})
