import { describe, expect, it } from 'vitest'
import {
  agentHistorySession,
  historyBlocksComposer,
} from '../../../../features/agent/lib/historySession'

describe('agentHistorySession', () => {
  it('treats a load as loading even if a failed flag was left on', () => {
    expect(
      agentHistorySession({
        historyCached: true,
        historyLoading: true,
        historyFailed: true,
      }),
    ).toEqual({ phase: 'loading', cached: true })
  })

  it('keeps the cached snapshot bit while syncing or after a sync failure', () => {
    expect(
      agentHistorySession({
        historyCached: true,
        historyLoading: true,
        historyFailed: false,
      }),
    ).toEqual({ phase: 'loading', cached: true })
    expect(
      agentHistorySession({
        historyCached: true,
        historyLoading: false,
        historyFailed: true,
      }),
    ).toEqual({ phase: 'failed', cached: true })
    expect(
      agentHistorySession({
        historyCached: false,
        historyLoading: false,
        historyFailed: true,
      }),
    ).toEqual({ phase: 'failed', cached: false })
  })

  it('drops the cached flag once history is idle, matching the status banner', () => {
    expect(
      agentHistorySession({
        historyCached: true,
        historyLoading: false,
        historyFailed: false,
      }),
    ).toEqual({ phase: 'idle' })
    expect(historyBlocksComposer({ phase: 'idle' })).toBe(false)
    expect(historyBlocksComposer({ phase: 'loading', cached: false })).toBe(true)
    expect(historyBlocksComposer({ phase: 'failed', cached: true })).toBe(true)
  })
})
