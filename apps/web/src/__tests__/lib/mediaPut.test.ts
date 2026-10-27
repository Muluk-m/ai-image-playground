// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { MEDIA_PUT_STALL_MS, putMedia } from '../../lib/mediaPut'
import { transferMedia } from '../../lib/mediaTransfer'

// 全局 setup 把 putMedia 换成了 fetch；这里测真的 XHR 实现。
vi.unmock('../../lib/mediaPut')

class FakeXhr {
  static all: FakeXhr[] = []
  status = 0
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = true
  aborted = false
  body: unknown
  upload: { onprogress?: (event: ProgressEvent) => void } = {}
  onprogress?: () => void
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  constructor() {
    FakeXhr.all.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent)
  }
  respond(status: number) {
    this.status = status
    this.onload?.()
  }
}

afterEach(() => {
  FakeXhr.all = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reports upload progress and resolves with the storage status', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  const seen: number[] = []
  const body = new ArrayBuffer(8)
  const sending = putMedia('https://storage.test/one', body, 'image/png', {
    signal: new AbortController().signal,
    onProgress: (fraction) => seen.push(fraction),
  })
  const xhr = FakeXhr.all[0]!
  expect(xhr).toMatchObject({
    method: 'PUT',
    url: 'https://storage.test/one',
    withCredentials: false,
  })
  expect(xhr.headers['content-type']).toBe('image/png')
  expect(xhr.body).toBe(body)
  xhr.progress(4, 8)
  xhr.progress(8, 8)
  xhr.respond(200)
  await expect(sending).resolves.toEqual({ ok: true, status: 200 })
  expect(seen).toEqual([0.5, 1])
})

it('aborts as a timeout once no bytes move for the stall window, but not while progress keeps coming', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  const sending = putMedia('https://storage.test/one', new ArrayBuffer(8), 'image/png', {
    signal: new AbortController().signal,
  })
  const failure = sending.catch((error: unknown) => error)
  const xhr = FakeXhr.all[0]!
  await vi.advanceTimersByTimeAsync(MEDIA_PUT_STALL_MS - 1_000)
  xhr.progress(1, 8)
  await vi.advanceTimersByTimeAsync(MEDIA_PUT_STALL_MS - 1_000)
  expect(xhr.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1_000)
  const error = await failure
  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('TimeoutError')
  expect(xhr.aborted).toBe(true)
})

it('rejects with the caller reason when cancelled', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  const controller = new AbortController()
  const sending = putMedia('https://storage.test/one', new ArrayBuffer(8), 'image/png', {
    signal: controller.signal,
  })
  controller.abort(new Error('gone'))
  await expect(sending).rejects.toThrow('gone')
  expect(FakeXhr.all[0]!.aborted).toBe(true)
})

it('retries a stalled upload with a fresh reservation and then confirms it', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  let reservations = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/media/uploads')) {
        reservations++
        return Response.json({
          id: 'media-1',
          status: 'pending',
          uploadUrl: `https://storage.test/one?try=${reservations}`,
        })
      }
      if (input.endsWith('/api/media/media-1/complete'))
        return Response.json({ id: 'media-1', status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  const progress: number[] = []
  const done = transferMedia(new ArrayBuffer(8), 'image/png', 'a'.repeat(64), {
    signal: new AbortController().signal,
    current: () => {},
    onProgress: (fraction) => progress.push(fraction),
  })
  await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1))
  FakeXhr.all[0]!.progress(2, 8)
  await vi.advanceTimersByTimeAsync(MEDIA_PUT_STALL_MS)
  expect(FakeXhr.all[0]!.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(2))
  expect(FakeXhr.all[1]!.url).toBe('https://storage.test/one?try=2')
  FakeXhr.all[1]!.progress(8, 8)
  FakeXhr.all[1]!.respond(200)
  await expect(done).resolves.toMatchObject({ id: 'media-1', status: 'ready' })
  expect(progress).toEqual([0.25, 1])
})
