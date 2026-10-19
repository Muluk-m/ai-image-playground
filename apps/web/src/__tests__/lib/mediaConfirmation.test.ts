// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { transferMedia } from '../../lib/mediaTransfer'
import { captureClientErrors } from '../helpers/clientErrors'

const runtime = vi.hoisted(() => ({ backend: 'https://api.test' }))
vi.mock('../../lib/runtimeConfig', () => ({ bffBaseUrl: () => runtime.backend }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setClientStorageScope(null)
  runtime.backend = 'https://api.test'
})

function fixture() {
  let finish!: (response: Response) => void
  const result = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const confirmations: AbortSignal[] = []
  let uploads = 0
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    if (input.endsWith('/uploads'))
      return Response.json({
        id: 'shared',
        status: 'pending',
        uploadUrl: 'https://storage.test/file',
      })
    if (init.method === 'PUT') {
      uploads++
      return new Response(null)
    }
    confirmations.push(init.signal!)
    return result.then(
      async (response) =>
        new Response(await response.clone().text(), {
          status: response.status,
          headers: response.headers,
        }),
    )
  })
  const upload = (signal: AbortSignal) =>
    transferMedia(new ArrayBuffer(8), 'image/png', 'hash', {
      signal,
      current: () => signal.throwIfAborted(),
    })
  return { upload, confirmations, uploads: () => uploads, finish }
}

it.each([
  0, 1,
])('shares confirmation and cancelling waiter %s leaves the other request alive', async (cancelled) => {
  const f = fixture()
  const reports = captureClientErrors()
  const controllers = [new AbortController(), new AbortController()]
  const pending = controllers.map((controller) => f.upload(controller.signal))
  await vi.waitFor(() => {
    expect(f.uploads()).toBe(2)
    expect(f.confirmations).toHaveLength(1)
  })
  const rejection = expect(pending[cancelled]).rejects.toThrow('removed')
  controllers[cancelled]!.abort(new Error('removed'))
  await rejection
  expect(f.confirmations[0]!.aborted).toBe(false)
  f.finish(Response.json({ id: 'shared', status: 'ready' }))
  expect(await pending[1 - cancelled]).toMatchObject({ id: 'shared', status: 'ready' })
  expect(await reports()).toEqual([])
})

it('aborts the network operation when all waiters leave and permits a new attempt', async () => {
  const reports = captureClientErrors()
  const f = fixture()
  const controller = new AbortController()
  const first = f.upload(controller.signal)
  const rejection = expect(first).rejects.toThrow('removed')
  await vi.waitFor(() => expect(f.confirmations).toHaveLength(1))
  controller.abort(new Error('removed'))
  await rejection
  expect(f.confirmations[0]!.aborted).toBe(true)
  const second = f.upload(new AbortController().signal)
  await vi.waitFor(() => expect(f.confirmations).toHaveLength(2))
  f.finish(Response.json({ id: 'shared', status: 'ready' }))
  expect(await second).toMatchObject({ status: 'ready' })
  expect(await reports()).toEqual([])
})

it.each(['account', 'backend'])('does not share across a changed %s', async (change) => {
  const reports = captureClientErrors()
  const f = fixture()
  setClientStorageScope('first')
  const first = f.upload(new AbortController().signal)
  await vi.waitFor(() => expect(f.confirmations).toHaveLength(1))
  if (change === 'account') setClientStorageScope('second')
  else runtime.backend = 'https://other.test'
  const second = f.upload(new AbortController().signal)
  await vi.waitFor(() => expect(f.confirmations).toHaveLength(2))
  const rejected = expect(first).rejects.toThrow('media_scope_changed')
  f.finish(Response.json({ id: 'shared', status: 'ready' }))
  await rejected
  expect(await second).toMatchObject({ status: 'ready' })
  expect(await reports()).toEqual([])
})

it.each([
  'wrong id',
  'not ready',
  'rejected',
])('reports a shared complete %s only once', async (outcome) => {
  const reports = captureClientErrors()
  const f = fixture()
  const first = f.upload(new AbortController().signal)
  const second = f.upload(new AbortController().signal)
  const finished = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(f.uploads()).toBe(2))
  expect(f.confirmations).toHaveLength(1)
  f.finish(
    outcome === 'rejected'
      ? Response.json({ error: 'SECRET-confirmation-url' }, { status: 400 })
      : Response.json({
          id: outcome === 'wrong id' ? 'other' : 'shared',
          status: outcome === 'not ready' ? 'pending' : 'ready',
        }),
  )
  const results = await finished
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  if (results[0]?.status === 'rejected' && results[1]?.status === 'rejected')
    expect(results[0].reason).toBe(results[1].reason)
  expect(f.confirmations).toHaveLength(1)
  const errors = (await reports()).flatMap((batch) => batch.errors)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toMatchObject({ operation: 'media.upload', stage: 'complete' })
  expect(JSON.stringify(await reports())).not.toContain('SECRET-confirmation-url')
})

it('reports a shared scheduling rejection once and preserves the thrown object', async () => {
  const reports = captureClientErrors()
  const f = fixture()
  const error = new Error('SECRET-scheduler-payload')
  const confirm = vi.fn(async () => {
    throw error
  })
  const pending = [0, 1].map(() =>
    transferMedia(new ArrayBuffer(8), 'image/png', 'hash', {
      signal: new AbortController().signal,
      current() {},
      confirm,
    }),
  )
  const results = await Promise.allSettled(pending)
  for (const result of results) {
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toBe(error)
  }
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(f.confirmations).toHaveLength(0)
  expect((await reports()).flatMap((batch) => batch.errors)).toHaveLength(1)
})

it('reports a shared failure once when one waiter has cancelled but another still needs the result', async () => {
  const reports = captureClientErrors()
  const f = fixture()
  const controller = new AbortController()
  const first = f.upload(controller.signal)
  const second = f.upload(new AbortController().signal)
  const finished = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(f.uploads()).toBe(2))
  const removed = new Error('removed')
  controller.abort(removed)
  f.finish(Response.json({ id: 'wrong-id', status: 'ready' }))
  const results = await finished
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  if (results[0]?.status === 'rejected') expect(results[0].reason).toBe(removed)
  expect((await reports()).flatMap((batch) => batch.errors)).toHaveLength(1)
})

it.each([
  'reserve',
  'put',
  'complete',
])('reports %s only after its four existing attempts', async (stage) => {
  const reports = captureClientErrors()
  vi.useFakeTimers()
  let reservations = 0
  let puts = 0
  let confirmations = 0
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    if (input.endsWith('/uploads')) {
      reservations++
      if (stage === 'reserve')
        return Response.json({ error: 'SECRET-reservation' }, { status: 503 })
      return Response.json({
        id: 'retry',
        status: 'pending',
        uploadUrl: 'https://storage.test/SECRET-signature',
      })
    }
    if (init.method === 'PUT') {
      puts++
      return new Response(null, { status: stage === 'put' ? 503 : 200 })
    }
    confirmations++
    return Response.json({ error: 'SECRET-confirmation' }, { status: 503 })
  })
  const pending = transferMedia(new ArrayBuffer(8), 'image/png', 'hash', {
    signal: new AbortController().signal,
    current() {},
  })
  const failed = expect(pending).rejects.toBeInstanceOf(Error)
  await vi.advanceTimersByTimeAsync(3500)
  await failed
  expect({ reservations, puts, confirmations }).toEqual(
    stage === 'reserve'
      ? { reservations: 4, puts: 0, confirmations: 0 }
      : stage === 'put'
        ? { reservations: 1, puts: 4, confirmations: 0 }
        : { reservations: 1, puts: 1, confirmations: 4 },
  )
  vi.useRealTimers()
  const errors = (await reports()).flatMap((batch) => batch.errors)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toMatchObject({ operation: 'media.upload', stage, status: 503 })
  expect(JSON.stringify(await reports())).not.toContain('SECRET')
})

it('attributes an exhausted signature refresh to reserve and keeps the final rejection', async () => {
  const reports = captureClientErrors()
  vi.useFakeTimers()
  let reservations = 0
  const failedRefresh = new TypeError('SECRET-refresh')
  vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
    if (init.method === 'PUT') return new Response(null, { status: 403 })
    reservations++
    if (reservations > 1) throw failedRefresh
    return Response.json({
      id: 'refresh',
      status: 'pending',
      uploadUrl: 'https://storage.test/file',
    })
  })
  const signal = new AbortController().signal
  const pending = transferMedia(new ArrayBuffer(8), 'image/png', 'hash', { signal, current() {} })
  const rejected = expect(pending).rejects.toBe(failedRefresh)
  await vi.advanceTimersByTimeAsync(3500)
  await rejected
  expect(reservations).toBe(4)
  vi.useRealTimers()
  const errors = (await reports()).flatMap((batch) => batch.errors)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toMatchObject({ stage: 'reserve', errorName: 'TypeError' })
})

it.each([
  'abort',
  'current',
  'account',
  'backend',
])('does not report a reserve interrupted by %s', async (change) => {
  const reports = captureClientErrors()
  const controller = new AbortController()
  const original = new Error('scope changed')
  let changed = false
  vi.stubGlobal('fetch', async () => {
    changed = true
    if (change === 'abort') controller.abort(original)
    if (change === 'account') setClientStorageScope('another')
    if (change === 'backend') runtime.backend = 'https://other.test'
    throw original
  })
  await expect(
    transferMedia(new ArrayBuffer(8), 'image/png', 'hash', {
      signal: controller.signal,
      current: () => {
        controller.signal.throwIfAborted()
        if (change === 'current' && changed) throw original
      },
    }),
  ).rejects.toBe(original)
  expect(await reports()).toEqual([])
})
