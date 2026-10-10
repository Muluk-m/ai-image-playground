// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { transferMedia } from '../../lib/mediaTransfer'

const runtime = vi.hoisted(() => ({ backend: 'https://api.test' }))
vi.mock('../../lib/runtimeConfig', () => ({ bffBaseUrl: () => runtime.backend }))
afterEach(() => {
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
})

it('aborts the network operation when all waiters leave and permits a new attempt', async () => {
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
})

it.each(['account', 'backend'])('does not share across a changed %s', async (change) => {
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
})
