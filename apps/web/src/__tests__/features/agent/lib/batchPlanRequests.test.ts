import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelBatchPlan,
  executeBatchCommand,
  fetchBatchPlan,
  subscribeBatchPlanChanges,
  updateBatchPlan,
} from '../../../../features/agent/lib/agentClient'
import { setClientStorageScope } from '../../../../lib/authScope'

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), baseUrl: 'https://batch.test' }))
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: fixture.fetch }))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => fixture.baseUrl }))

const page = (status = 'closed', items: unknown[] = []) => ({
  batch: { status },
  items,
  nextCursor: null,
})
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  fixture.fetch.mockReset()
  fixture.baseUrl = 'https://batch.test'
  setClientStorageScope(crypto.randomUUID())
})
afterEach(() => {
  setClientStorageScope(null)
  vi.useRealTimers()
})

describe('shared batch reads', () => {
  it('coalesces concurrent readers but never retains running, paused or draft plans', async () => {
    for (const status of ['running', 'paused', 'draft']) {
      fixture.fetch.mockClear().mockResolvedValue(response(page(status)))
      await Promise.all([
        fetchBatchPlan(status, { reuseSettled: true }),
        fetchBatchPlan(status, { reuseSettled: true }),
        fetchBatchPlan(status),
      ])
      expect(fixture.fetch).toHaveBeenCalledTimes(1)
      fixture.fetch.mockResolvedValue(response(page(status)))
      await fetchBatchPlan(status, { reuseSettled: true })
      expect(fixture.fetch).toHaveBeenCalledTimes(2)
    }
  })

  it('reuses terminal results briefly and lets normal editor reads and forced reloads invalidate them', async () => {
    vi.useFakeTimers()
    fixture.fetch.mockImplementation(async () => response(page()))
    await fetchBatchPlan('batch', { reuseSettled: true })
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    await fetchBatchPlan('batch')
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    await fetchBatchPlan('batch', { reuseSettled: true, force: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_001)
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(4)
  })

  it('does not reuse cancelled results with outstanding reconciliation', async () => {
    fixture.fetch.mockImplementation(async () =>
      response(page('cancelled', [{ progress: 'reconciling' }])),
    )
    await fetchBatchPlan('batch', { reuseSettled: true })
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([403, 404, 503])('releases failed requests (%s) for a later retry', async (status) => {
    fixture.fetch.mockResolvedValueOnce(new Response('{}', { status }))
    await expect(fetchBatchPlan('batch')).rejects.toMatchObject({ status })
    fixture.fetch.mockResolvedValueOnce(response(page()))
    await expect(fetchBatchPlan('batch')).resolves.toMatchObject(page())
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })

  it('isolates pending and completed reads by account and backend', async () => {
    let finish!: (response: Response) => void
    fixture.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const old = fetchBatchPlan('batch', { reuseSettled: true })
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    setClientStorageScope('next-account')
    fixture.fetch.mockImplementation(async () => response(page()))
    await fetchBatchPlan('batch', { reuseSettled: true })
    finish(response(page('cancelled')))
    await rejected
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    fixture.baseUrl = 'https://other-batch.test'
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not let an older in-flight result overwrite an explicit reload', async () => {
    let finish!: (response: Response) => void
    fixture.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const old = fetchBatchPlan('batch', { reuseSettled: true })
    fixture.fetch.mockResolvedValueOnce(response(page('cancelled')))
    await fetchBatchPlan('batch', { reuseSettled: true, force: true })
    finish(response(page()))
    await old
    await expect(fetchBatchPlan('batch', { reuseSettled: true })).resolves.toMatchObject(
      page('cancelled'),
    )
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    'update',
    'cancel',
    'command',
  ])('invalidates cached results after a %s mutation', async (action) => {
    fixture.fetch.mockImplementation(async () => response(page()))
    await fetchBatchPlan('batch', { reuseSettled: true })
    if (action === 'update')
      await updateBatchPlan('batch', {
        expectedVersion: 1,
        title: 'changed',
        rule: 'rule',
        items: [],
      })
    else if (action === 'cancel') await cancelBatchPlan('batch', 1)
    else
      await executeBatchCommand('batch', {
        action: 'pause',
        commandId: 'command',
        expectedVersion: 1,
      })
    await fetchBatchPlan('batch', { reuseSettled: true })
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
  })

  it('refreshes an asset reader after resuming a cached plan', async () => {
    let status = 'closed'
    let observed = ''
    fixture.fetch.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') status = 'running'
      return response(page(status))
    })
    await fetchBatchPlan('batch', { reuseSettled: true })
    const stop = subscribeBatchPlanChanges((id) => {
      void fetchBatchPlan(id, { reuseSettled: true }).then((result) => {
        observed = result.batch.status
      })
    })
    try {
      await executeBatchCommand('batch', {
        action: 'resume',
        commandId: 'resume-command',
        expectedVersion: 1,
        expectedDigest: 'digest',
        deviceId: 'device',
      })
      await vi.waitFor(() => expect(observed).toBe('running'))
    } finally {
      stop()
    }
  })

  it('refreshes for another tab but ignores its notifications after an account change', async () => {
    const Channel = globalThis.BroadcastChannel
    const channels: BroadcastChannel[] = []
    vi.stubGlobal(
      'BroadcastChannel',
      class extends Channel {
        constructor(name: string) {
          super(name)
          channels.push(this)
        }
      },
    )
    let status = 'closed'
    let observed = ''
    let peer: BroadcastChannel | undefined
    let stop = () => {}
    fixture.fetch.mockImplementation(async () => response(page(status)))
    try {
      await fetchBatchPlan('batch', { reuseSettled: true })
      stop = subscribeBatchPlanChanges((id) => {
        void fetchBatchPlan(id, { reuseSettled: true }).then((result) => {
          observed = result.batch.status
        })
      })
      const receiver = channels[0]!
      peer = new Channel(receiver.name)
      status = 'running'
      peer.postMessage('batch')
      await vi.waitFor(() => expect(observed).toBe('running'))

      setClientStorageScope('other-account')
      status = 'closed'
      await fetchBatchPlan('batch', { reuseSettled: true })
      status = 'running'
      const received = new Promise<void>((resolve) => {
        receiver.addEventListener('message', () => resolve(), { once: true })
      })
      peer.postMessage('batch')
      await received
      expect((await fetchBatchPlan('batch', { reuseSettled: true })).batch.status).toBe('closed')
    } finally {
      peer?.close()
      stop()
      vi.unstubAllGlobals()
    }
  })
})
