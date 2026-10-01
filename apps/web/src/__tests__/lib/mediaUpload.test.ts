// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { uploadMediaSource } from '../../lib/mediaUpload'

const source = 'data:image/png;base64,iVBORw0KGgo='
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
afterEach(() => vi.unstubAllGlobals())

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
