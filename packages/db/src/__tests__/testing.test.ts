import { describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '../testing'

describe('resetTestDatabase', () => {
  // One `it` on purpose: the guard is process-wide state, so the three assertions have to observe
  // it in order.
  it('hands one database to its own suite and refuses a second suite in the same process', async () => {
    const databaseUrl = await resetTestDatabase('db_testing_guard')
    expect(databaseUrl).toContain('db_testing_guard')

    // Re-resetting the same suite is how a single file gets a clean database; still allowed.
    expect(await resetTestDatabase('db_testing_guard')).toBe(databaseUrl)

    const second = resetTestDatabase('db_testing_guard_other')
    await expect(second).rejects.toThrow(/its own process/)
    await expect(second).rejects.toThrow(/db_testing_guard/)
  }, 60_000)
})
