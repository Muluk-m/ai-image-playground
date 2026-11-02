// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadBlob,
  downloadImagesByIds,
  REVOKE_OBJECT_URL_DELAY_MS,
} from '../../lib/downloadImages'
import * as imageSource from '../../lib/imageSource'
import { captureClientErrors } from '../helpers/clientErrors'

describe('downloadBlob', () => {
  const objectUrl = 'blob:mock/download'
  let revoke: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    revoke = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: revoke,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps the object URL alive after the click and revokes it once the delay elapses', () => {
    const clicked: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href)
    })

    downloadBlob(new Blob(['x'], { type: 'image/png' }), 'a.png')

    expect(clicked).toEqual([objectUrl])
    expect(document.querySelector('a[download]')).toBeNull()

    vi.advanceTimersByTime(REVOKE_OBJECT_URL_DELAY_MS - 1)
    expect(revoke).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith(objectUrl)

    click.mockRestore()
  })
})

describe('downloadImagesByIds diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports a missing original and a failed fetch without changing result counts', async () => {
    const reports = captureClientErrors()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(imageSource, 'loadImageOriginal')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('https://storage.test/SECRET-signature')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('SECRET-file-prompt')))
    expect(await downloadImagesByIds(['missing', 'broken'], 'SECRET-filename')).toEqual({
      success: 0,
      failed: 2,
    })
    const errors = (await reports()).flatMap((batch) => batch.errors)
    expect(errors.map((error) => error.context?.stage)).toEqual(['original', 'fetch'])
    expect(errors[0]?.context?.errorCode).toBe('original_missing')
    expect(JSON.stringify(await reports())).not.toContain('SECRET')
  })

  it('reports a trigger failure once at the caller boundary', async () => {
    const reports = captureClientErrors()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(imageSource, 'loadImageOriginal').mockResolvedValue('data:image/png;base64,AA==')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x')))
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        throw new Error('SECRET-trigger')
      },
    })
    expect(await downloadImagesByIds(['one'])).toEqual({ success: 0, failed: 1 })
    const errors = (await reports()).flatMap((batch) => batch.errors)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context?.stage).toBe('trigger')
  })
})
