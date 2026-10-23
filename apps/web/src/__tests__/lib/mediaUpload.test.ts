// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { MEDIA_UPLOAD_TIMING_FLAG, uploadMediaSource } from '../../lib/mediaUpload'

const source = 'data:image/png;base64,iVBORw0KGgo='
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('uploads the original bytes without a canvas and waits for server confirmation', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const states: string[] = []
  let finish!: (response: Response) => void
  let confirmStarted!: () => void
  const confirming = new Promise<void>((resolve) => {
    confirmStarted = resolve
  })
  const confirmation = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const sent: Uint8Array[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          bytes: 8,
          contentType: 'image/png',
          purpose: 'conversation-attachment',
        })
        return Response.json({
          id: 'media-1',
          status: 'pending',
          uploadUrl: 'https://storage.test/one',
          leaseExpiresAt: 123456,
        })
      }
      if (input === 'https://storage.test/one') {
        sent.push(new Uint8Array(init?.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      if (input.endsWith('/api/media/media-1/complete')) {
        confirmStarted()
        return confirmation
      }
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  const uploading = uploadMediaSource(source, {
    signal: new AbortController().signal,
    purpose: 'conversation-attachment',
    onState: (state) => states.push(state),
  })
  await confirming
  expect(states).toEqual(['queued', 'uploading', 'verifying'])
  expect(sent).toEqual([bytes])
  finish(Response.json({ id: 'media-1', status: 'ready', leaseExpiresAt: 123456 }))
  expect(await uploading).toMatchObject({ id: 'media-1', leaseExpiresAt: 123456 })
  expect(states[states.length - 1]).toBe('ready')
})

it('rejects unsupported GIF before browser decoding, raster allocation or upload', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 0, 250, 0, 250])
  const oversized = `data:image/gif;base64,${btoa(String.fromCharCode(...gif))}`
  const decode = vi.fn()
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 64_000
      naturalHeight = 64_000
      onload?: () => void
      set src(_source: string) {
        decode()
        queueMicrotask(() => this.onload?.())
      }
    },
  )
  const allocations: string[] = []
  const create = document.createElement.bind(document)
  const elements = vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    allocations.push(tag)
    return create(tag, options)
  })
  const uploads: string[] = []
  vi.stubGlobal('fetch', async (input: string) => {
    if (input === oversized) return new Response(gif)
    uploads.push(input)
    throw new Error(`Unexpected upload ${input}`)
  })
  try {
    await expect(
      uploadMediaSource(oversized, {
        signal: new AbortController().signal,
        purpose: 'conversation-attachment',
      }),
    ).rejects.toThrow('media_unsupported_image')
    expect(decode).not.toHaveBeenCalled()
    expect(allocations).not.toContain('canvas')
    expect(uploads).toEqual([])
  } finally {
    elements.mockRestore()
  }
})

it('retries busy confirmation without uploading successful bytes again', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.useFakeTimers()
  let confirmations = 0
  let puts = 0
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === source) return new Response(bytes)
    if (input.endsWith('/uploads'))
      return Response.json({
        id: 'retry',
        status: 'pending',
        uploadUrl: 'https://storage.test/retry',
      })
    if (init?.method === 'PUT') {
      puts++
      return new Response(null)
    }
    if (input.endsWith('/complete')) {
      confirmations++
      return confirmations < 3
        ? Response.json({ error: 'media_processing_busy' }, { status: 503 })
        : Response.json({ id: 'retry', status: 'ready' })
    }
    throw new Error(`Unexpected fetch ${input}`)
  })
  const uploading = uploadMediaSource(source, { signal: new AbortController().signal })
  await vi.waitFor(() => expect(confirmations).toBe(1))
  await vi.advanceTimersByTimeAsync(1500)
  expect(await uploading).toMatchObject({ id: 'retry' })
  expect(confirmations).toBe(3)
  expect(puts).toBe(1)
})

it('recovers a transient PUT failure while preserving the original bytes', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.useFakeTimers()
  const bodies: Uint8Array[] = []
  const urls: string[] = []
  let reservations = 0
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === source) return new Response(bytes)
    if (input.endsWith('/uploads')) {
      reservations++
      return Response.json({
        id: 'put-retry',
        status: 'pending',
        uploadUrl: `https://storage.test/retry-${reservations}`,
      })
    }
    if (init?.method === 'PUT') {
      urls.push(input)
      bodies.push(new Uint8Array(init.body as ArrayBuffer))
      if (bodies.length === 1) throw new TypeError('network interrupted')
      return new Response(null)
    }
    if (input.endsWith('/complete')) return Response.json({ id: 'put-retry', status: 'ready' })
    throw new Error(`Unexpected fetch ${input}`)
  })
  const uploading = uploadMediaSource(source, { signal: new AbortController().signal })
  await vi.waitFor(() => expect(bodies).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(500)
  expect(await uploading).toMatchObject({ id: 'put-retry' })
  expect(bodies).toEqual([bytes, bytes])
  expect(urls).toEqual(['https://storage.test/retry-1', 'https://storage.test/retry-2'])
})

it('stops retrying when removed during backoff', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.useFakeTimers()
  let confirmations = 0
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === source) return new Response(bytes)
    if (input.endsWith('/uploads'))
      return Response.json({
        id: 'cancel',
        status: 'pending',
        uploadUrl: 'https://storage.test/cancel',
      })
    if (init?.method === 'PUT') return new Response(null)
    if (input.endsWith('/complete')) {
      confirmations++
      return Response.json({ error: 'media_processing_busy' }, { status: 503 })
    }
    throw new Error(`Unexpected fetch ${input}`)
  })
  const controller = new AbortController()
  const uploading = uploadMediaSource(source, { signal: controller.signal })
  const rejected = expect(uploading).rejects.toThrow('removed')
  await vi.waitFor(() => expect(confirmations).toBe(1))
  controller.abort(new Error('removed'))
  await rejected
  await vi.advanceTimersByTimeAsync(5000)
  expect(confirmations).toBe(1)
})

it.each([
  [new TypeError('Failed to fetch'), 'media_network_error'],
  [new DOMException('timed out', 'TimeoutError'), 'media_timeout'],
])('preserves a useful failure code when reading the upload source fails: %s', async (error, code) => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
  const states: string[] = []
  await expect(
    uploadMediaSource(source, {
      signal: new AbortController().signal,
      purpose: 'conversation-attachment',
      onState: (state) => states.push(state),
    }),
  ).rejects.toThrow(code)
  expect(states[states.length - 1]).toBe('failed')
})

it('logs per-stage timing and bytes for each uploaded image', async () => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.setItem(MEDIA_UPLOAD_TIMING_FLAG, '1')
  const info = vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads'))
        return Response.json({
          id: 'media-t',
          status: 'pending',
          uploadUrl: 'https://storage.test/t',
        })
      if (input === 'https://storage.test/t') return new Response(null, { status: 200 })
      if (input.endsWith('/api/media/media-t/complete'))
        return Response.json({ id: 'media-t', status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  try {
    await uploadMediaSource(source, { signal: new AbortController().signal })
    const entry = info.mock.calls.find(([label]) => label === '[media.upload]')?.[1] as {
      outcome: string
      mediaId: string
      bytes: number
      contentType: string
      totalMs: number
      phaseMs: Record<string, number>
    }
    expect(entry).toMatchObject({
      outcome: 'uploaded',
      mediaId: 'media-t',
      bytes: 8,
      contentType: 'image/png',
    })
    expect(Object.keys(entry.phaseMs)).toEqual([
      'queue',
      'read',
      'hash',
      'convert',
      'reserve',
      'put',
      'confirm_wait',
      'confirm',
    ])
    const summed = Object.values(entry.phaseMs).reduce((total, ms) => total + ms, 0)
    expect(Math.abs(summed - entry.totalMs)).toBeLessThanOrEqual(7)
  } finally {
    info.mockRestore()
    localStorage.removeItem(MEDIA_UPLOAD_TIMING_FLAG)
  }
})

it('logs a failed upload with the stage it reached', async () => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.setItem(MEDIA_UPLOAD_TIMING_FLAG, '1')
  const info = vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads'))
        return Response.json({ error: 'media_quota_exceeded' }, { status: 413 })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  try {
    await expect(
      uploadMediaSource(source, { signal: new AbortController().signal }),
    ).rejects.toThrow()
    const entry = info.mock.calls.find(([label]) => label === '[media.upload]')?.[1] as {
      outcome: string
      error: string
      phaseMs: Record<string, number>
    }
    expect(entry.outcome).toBe('failed')
    expect(entry.error).toBe('media_quota_exceeded')
    expect(Object.keys(entry.phaseMs)).toEqual(['queue', 'read', 'hash', 'convert', 'reserve'])
  } finally {
    info.mockRestore()
    localStorage.removeItem(MEDIA_UPLOAD_TIMING_FLAG)
  }
})

it('logs hash hits too, and keeps the media id when confirmation fails after the PUT', async () => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.setItem(MEDIA_UPLOAD_TIMING_FLAG, '1')
  const info = vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads'))
        return Response.json({
          id: 'media-f',
          status: 'pending',
          uploadUrl: 'https://storage.test/f',
        })
      if (input === 'https://storage.test/f') return new Response(null, { status: 200 })
      if (input.endsWith('/api/media/media-f/complete'))
        return Response.json({ error: 'media_invalid_image' }, { status: 422 })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  try {
    const sha256 = Array.from(
      new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    await uploadMediaSource(source, {
      signal: new AbortController().signal,
      known: { id: 'media-known', sha256 },
    })
    await expect(
      uploadMediaSource(source, { signal: new AbortController().signal }),
    ).rejects.toThrow()
    const entries = info.mock.calls
      .filter(([label]) => label === '[media.upload]')
      .map(([, entry]) => entry as { outcome: string; mediaId?: string; error?: string })
    expect(entries.map(({ outcome, mediaId, error }) => ({ outcome, mediaId, error }))).toEqual([
      { outcome: 'known', mediaId: undefined, error: undefined },
      { outcome: 'failed', mediaId: 'media-f', error: 'media_invalid_image' },
    ])
  } finally {
    info.mockRestore()
    localStorage.removeItem(MEDIA_UPLOAD_TIMING_FLAG)
  }
})

it('marks a confirmation joined from another upload of the same image as confirm_shared', async () => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.setItem(MEDIA_UPLOAD_TIMING_FLAG, '1')
  const info = vi.spyOn(console, 'debug').mockImplementation(() => {})
  let finishConfirm!: () => void
  const confirmGate = new Promise<void>((resolve) => {
    finishConfirm = resolve
  })
  let puts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads'))
        return Response.json({
          id: 'media-s',
          status: 'pending',
          uploadUrl: 'https://storage.test/s',
        })
      if (input === 'https://storage.test/s') {
        puts++
        return new Response(null, { status: 200 })
      }
      if (input.endsWith('/api/media/media-s/complete')) {
        await confirmGate
        return Response.json({ id: 'media-s', status: 'ready' })
      }
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  try {
    const both = [
      uploadMediaSource(source, { signal: new AbortController().signal }),
      uploadMediaSource(source, { signal: new AbortController().signal }),
    ]
    await vi.waitFor(() => expect(puts).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 10))
    finishConfirm()
    await Promise.all(both)
    const phases = info.mock.calls
      .filter(([label]) => label === '[media.upload]')
      .map(([, entry]) => Object.keys((entry as { phaseMs: Record<string, number> }).phaseMs))
    expect(phases).toContainEqual(expect.arrayContaining(['confirm']))
    expect(phases).toContainEqual(expect.arrayContaining(['confirm_shared']))
  } finally {
    info.mockRestore()
    localStorage.removeItem(MEDIA_UPLOAD_TIMING_FLAG)
  }
})

it('logs nothing unless upload timing is switched on for this browser', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === source) return new Response(bytes)
      if (input.endsWith('/api/media/uploads'))
        return Response.json({ id: 'media-q', status: 'ready' })
      throw new Error(`Unexpected fetch ${input}`)
    }),
  )
  try {
    await uploadMediaSource(source, { signal: new AbortController().signal })
    expect(debug.mock.calls.filter(([label]) => label === '[media.upload]')).toHaveLength(0)
  } finally {
    debug.mockRestore()
  }
})

it.each([
  ['an empty file', 'data:image/png;base64,', new Uint8Array()],
  [
    'text renamed to .png',
    `data:image/png;base64,${btoa('not an image')}`,
    new TextEncoder().encode('not an image'),
  ],
])('reports %s as a permanent invalid image without asking the server', async (_name, input, body) => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'Image',
    class {
      onerror?: () => void
      set src(_source: string) {
        queueMicrotask(() => this.onerror?.())
      }
    },
  )
  const fetch = vi.fn(async (url: string) => {
    if (url === input) return new Response(body)
    throw new Error(`Unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  await expect(
    uploadMediaSource(input, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ status: 422, code: 'media_invalid_image' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('keeps a PNG conversion failure retryable when the browser could decode the image', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 1
      naturalHeight = 1
      onload?: () => void
      set src(_source: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
  // 解码成功、但拿不到 2d 画布：不是这份字节坏了，不能报成永久的坏图。
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const input = `data:image/png;base64,${btoa('decodable but unsniffed')}`
  const fetch = vi.fn(async (url: string) => {
    if (url === input) return new Response(new TextEncoder().encode('decodable but unsniffed'))
    throw new Error(`Unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const error = await uploadMediaSource(input, { signal: new AbortController().signal }).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toMatchObject({ code: 'media_invalid_image' })
  context.mockRestore()
})
