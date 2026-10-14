import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposeClip } from '../../../../features/canvas/lib/composeFilm'
import { composeInWorker } from '../../../../features/canvas/lib/filmPipeline'
import type { FilmWorkerResponse } from '../../../../features/canvas/lib/filmWorker'

class TestWorker {
  onmessage: ((event: MessageEvent<FilmWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  emit(data: FilmWorkerResponse) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}
function setup() {
  const mock = new TestWorker()
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      return mock
    }),
  )
  const controller = new AbortController()
  const clip: ComposeClip = { blob: new Blob(['clip']), in: 0, audio: [new Float32Array(2)] }
  const handlers = {
    loadClip: vi.fn(async () => clip),
    write: vi.fn(async () => {}),
    onProgress: vi.fn(),
  }
  const done = composeInWorker(new Worker('fixture'), 64, controller.signal, handlers)
  return { mock, controller, handlers, done, clip }
}
afterEach(() => vi.unstubAllGlobals())

describe('streamed film worker', () => {
  it('loads only requested clips and acknowledges chunks after disk backpressure clears', async () => {
    const { mock, handlers, done, clip } = setup()
    expect(mock.postMessage).toHaveBeenCalledWith({ type: 'start', count: 64 }, [])
    expect(handlers.loadClip).not.toHaveBeenCalled()
    mock.emit({ type: 'clip', index: 0 })
    await vi.waitFor(() =>
      expect(mock.postMessage).toHaveBeenCalledWith({ type: 'clip', clip }, [
        clip.audio[0]!.buffer,
      ]),
    )
    let written!: () => void
    handlers.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          written = resolve
        }),
    )
    const chunk = { type: 'write' as const, position: 42, data: new Uint8Array([1, 2]) }
    mock.emit({ type: 'write', chunk })
    expect(handlers.write).toHaveBeenCalledWith(chunk)
    expect(mock.postMessage).not.toHaveBeenCalledWith({ type: 'written' }, [])
    written()
    await vi.waitFor(() => expect(mock.postMessage).toHaveBeenCalledWith({ type: 'written' }, []))
    mock.emit({ type: 'done' })
    await done
    expect(mock.terminate).toHaveBeenCalledOnce()
  })

  it('does not send a late clip after cancellation', async () => {
    const { mock, controller, handlers, done, clip } = setup()
    let loaded!: (clip: ComposeClip) => void
    handlers.loadClip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve
        }),
    )
    mock.emit({ type: 'clip', index: 0 })
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    expect(mock.terminate).toHaveBeenCalledOnce()
    const finished = vi.fn()
    void done.catch(finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    loaded(clip)
    await rejected
    expect(mock.postMessage).toHaveBeenCalledTimes(1)
    expect(mock.terminate).toHaveBeenCalledOnce()
  })

  it('ends the worker on storage failure without acknowledging the failed write', async () => {
    const { mock, handlers, done } = setup()
    handlers.write.mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'))
    const rejected = expect(done).rejects.toMatchObject({ name: 'QuotaExceededError' })
    mock.emit({ type: 'write', chunk: { type: 'write', position: 0, data: new Uint8Array(1) } })
    await rejected
    expect(mock.postMessage).toHaveBeenCalledTimes(1)
    expect(mock.terminate).toHaveBeenCalledOnce()
  })
})
