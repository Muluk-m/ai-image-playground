import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { claimQueuedTask } from '../db/claim-task'

const databaseUrl = await resetTestDatabase('bff_claim_concurrency')
const first = createDb(databaseUrl)
const second = createDb(databaseUrl)

afterAll(async () => {
  await Promise.all([first.close(), second.close()])
})

describe('claimQueuedTask', () => {
  it('allows exactly one independent worker to claim a queued task', async () => {
    await first.db.insert(first.schema.tasks).values({
      id: 'single-claim',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'queued',
      request_payload: { prompt: 'claim once', device_id: 'claim-device' },
      submitted_at: Date.now(),
    })

    const outcomes = await Promise.all([
      claimQueuedTask(first.db, 'single-claim', Date.now()),
      claimQueuedTask(second.db, 'single-claim', Date.now()),
    ])

    expect(outcomes.sort()).toEqual([false, true])
    const [task] = await first.db.select().from(first.schema.tasks)
    expect(task?.status).toBe('in_progress')
  })
})
