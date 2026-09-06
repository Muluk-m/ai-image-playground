// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob, REVOKE_OBJECT_URL_DELAY_MS } from '../../lib/downloadImages'

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
