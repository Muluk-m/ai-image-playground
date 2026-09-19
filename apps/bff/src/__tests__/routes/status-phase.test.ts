import { describe, expect, it } from 'bun:test'

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
const { taskProgressPhase } = await import('../../routes/status')

const base = {
  status: 'in_progress' as const,
  archive_payload: null,
  upstream_task_ids: null,
  lease_expires_at: Date.now() + 60_000,
}

describe('queue status phase', () => {
  it('separates queueing, generation, reconnection and result confirmation', () => {
    expect(taskProgressPhase({ ...base, status: 'queued' })).toBe('queued')
    expect(taskProgressPhase(base)).toBe('generating')
    expect(taskProgressPhase({ ...base, lease_expires_at: Date.now() - 1 })).toBe('reconnecting')
    expect(taskProgressPhase({ ...base, archive_payload: { outputs: [] } })).toBe('confirming')
    expect(
      taskProgressPhase({ ...base, status: 'queued', upstream_task_ids: ['upstream-task'] }),
    ).toBe('reconnecting')
  })
})
