import type { StreamTargetChunk } from 'mediabunny'
import type { ComposeClip, ComposeFailure } from './composeFilm'
import { FILM_SAMPLE_RATE, type FilmClip } from './filmSpec'
import type { FilmWorkerRequest, FilmWorkerResponse } from './filmWorker'

/** 成片流水线里不依赖应用（鉴权、下载）的部分，单独成模块方便在真实浏览器里验证。 */

export type FilmExportFailure = ComposeFailure | 'fetch' | 'encode' | 'zipTooLarge'

export class FilmExportError extends Error {
  constructor(
    readonly reason: FilmExportFailure,
    /** 出问题的是第几段（从 1 数）。 */
    readonly position?: number,
    message?: string,
  ) {
    super(message ?? reason)
  }
}

/**
 * 解码一段的音轨并重采样到 48 kHz，从入点截到出点。WebAudio 在 Worker 里没有，
 * 所以在主线程解。没有音轨（decodeAudioData 报错）返回空数组，合成时补静音。
 */
export async function decodeClipAudio(
  blob: Blob,
  clip: Pick<FilmClip, 'in' | 'out'>,
): Promise<Float32Array[]> {
  const context = new OfflineAudioContext(2, 1, FILM_SAMPLE_RATE)
  let buffer: AudioBuffer
  try {
    buffer = await context.decodeAudioData(await blob.arrayBuffer())
  } catch {
    return []
  }
  const start = Math.min(buffer.length, Math.round(clip.in * FILM_SAMPLE_RATE))
  const end =
    clip.out === undefined
      ? buffer.length
      : Math.min(buffer.length, Math.round(clip.out * FILM_SAMPLE_RATE))
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
    buffer.getChannelData(ch).slice(start, Math.max(start, end)),
  )
}

/** 一次只传一段原片；每次写盘确认后才允许 Worker 继续输出。 */
export function composeInWorker(
  worker: Worker,
  count: number,
  signal: AbortSignal,
  handlers: {
    loadClip: (index: number) => Promise<ComposeClip>
    write: (chunk: StreamTargetChunk) => Promise<void>
    onProgress: (fraction: number) => void
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const pending = new Set<Promise<void>>()
    const settle = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      // decodeAudioData 不可取消；等当前解码释放后再让 UI 开始下一次导出。
      void Promise.allSettled(pending).then(() => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }
    function onAbort() {
      settle(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    const post = (message: FilmWorkerRequest, transfer: Transferable[] = []) => {
      if (!settled) worker.postMessage(message, transfer)
    }
    const track = (task: Promise<void>) => {
      pending.add(task)
      void task.catch(settle).finally(() => pending.delete(task))
    }
    worker.onmessage = (event: MessageEvent<FilmWorkerResponse>) => {
      if (settled) return
      const data = event.data
      if (data.type === 'clip') {
        track(
          handlers.loadClip(data.index).then((clip) => {
            post(
              { type: 'clip', clip },
              clip.audio.map((channel) => channel.buffer),
            )
          }),
        )
      } else if (data.type === 'write') {
        track(handlers.write(data.chunk).then(() => post({ type: 'written' })))
      } else if (data.type === 'progress') handlers.onProgress(data.fraction)
      else if (data.type === 'done') settle()
      else settle(new FilmExportError(data.reason, data.position, data.message))
    }
    worker.onerror = (event) => settle(new FilmExportError('encode', undefined, event.message))
    try {
      post({ type: 'start', count })
    } catch (error) {
      settle(error)
    }
  })
}
