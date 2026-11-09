// @vitest-environment jsdom
import type { AgentBackgroundJobView } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRequestError } from '../../../../features/agent/lib/agentClient'
import {
  configureAgentJobActivity,
  reportAgentPanel,
  resetAgentJobActivity,
  useAgentJobActivity,
} from '../../../../features/agent/lib/jobActivity'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { setClientStorageScope } from '../../../../lib/authScope'

const pending: AgentToolMessage = {
  kind: 'tool',
  id: 'job',
  turnId: 'turn',
  toolCallId: 'call',
  title: 'image',
  toolName: 'generateImage',
  status: 'submitted',
  job: { taskId: 'task', media: 'image' },
}
const jobs = [
  { messageId: pending.id, turnId: pending.turnId, result: pending },
] as unknown as AgentBackgroundJobView[]
const fetchJobs = vi.fn(async (): Promise<readonly AgentBackgroundJobView[]> => jobs)
let visibility: 'visible' | 'hidden'

function leaveConversation() {
  reportAgentPanel('conversation', [pending])
  reportAgentPanel(null, [], { conversationId: 'conversation', messages: [pending] })
}
function show(next: 'visible' | 'hidden') {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

// The web package targets ES2020, which does not include Promise.withResolvers.
function deferredJobs() {
  let resolve!: (jobs: readonly AgentBackgroundJobView[]) => void
  const promise = new Promise<readonly AgentBackgroundJobView[]>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  setClientStorageScope('polling-account')
  resetAgentJobActivity()
  fetchJobs.mockReset().mockResolvedValue(jobs)
  configureAgentJobActivity({
    fetchJobs,
    viewing: () => false,
    refreshCovers: () => {},
    pollIntervalMs: 5_000,
    hiddenPollIntervalMs: 30_000,
  })
})
afterEach(() => {
  resetAgentJobActivity()
  setClientStorageScope(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('background job polling cadence', () => {
  it('polls every five seconds while visible and every thirty seconds while hidden', async () => {
    leaveConversation()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchJobs).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchJobs).toHaveBeenCalledTimes(2)
    show('hidden')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchJobs).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchJobs).toHaveBeenCalledTimes(3)
    show('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJobs).toHaveBeenCalledTimes(4)
  })

  it('catches up after an in-flight request without overlapping requests', async () => {
    const deferred = deferredJobs()
    fetchJobs.mockReturnValueOnce(deferred.promise)
    leaveConversation()
    await vi.advanceTimersByTimeAsync(5_000)
    show('hidden')
    show('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    deferred.resolve(jobs)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJobs).toHaveBeenCalledTimes(2)
  })

  it('cleans timers and visibility listeners when reset or the panel takes over', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    leaveConversation()
    reportAgentPanel('conversation', [pending])
    show('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    reportAgentPanel(null, [], { conversationId: 'conversation', messages: [pending] })
    resetAgentJobActivity()
    show('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards an old account response and clears its activity', async () => {
    const deferred = deferredJobs()
    fetchJobs.mockReturnValueOnce(deferred.promise)
    leaveConversation()
    await vi.advanceTimersByTimeAsync(5_000)
    setClientStorageScope('other-account')
    deferred.resolve(jobs)
    await vi.advanceTimersByTimeAsync(0)
    expect(useAgentJobActivity.getState()).toMatchObject({ activity: {}, notice: null })
    show('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404])('stops inaccessible conversations after HTTP %s', async (status) => {
    fetchJobs.mockRejectedValueOnce(new AgentRequestError(status))
    leaveConversation()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(useAgentJobActivity.getState().activity).toEqual({})
    show('hidden')
    show('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
