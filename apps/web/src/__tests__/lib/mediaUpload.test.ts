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
