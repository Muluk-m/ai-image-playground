import type { ComposeClip, ComposeFailure } from './composeFilm'
import { FILM_SAMPLE_RATE, type FilmClip } from './filmSpec'
import type { FilmWorkerRequest, FilmWorkerResponse } from './filmWorker'

/** 成片流水线里不依赖应用（鉴权、下载）的部分，单独成模块方便在真实浏览器里验证。 */

export type FilmExportFailure = ComposeFailure | 'fetch' | 'encode'

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

/** 在 Worker 里合成。取消或失败都直接结束 Worker，编了一半的数据随之释放。 */
export function composeInWorker(
  worker: Worker,
  clips: ComposeClip[],
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      finish()
    }
    function onAbort() {
      settle(() => reject(signal.reason))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<FilmWorkerResponse>) => {
      const data = event.data
      if (data.type === 'progress') onProgress(data.fraction)
      else if (data.type === 'done') settle(() => resolve(data.buffer))
      else settle(() => reject(new FilmExportError(data.reason, data.position, data.message)))
    }
    worker.onerror = (event) => {
      settle(() => reject(new FilmExportError('encode', undefined, event.message)))
    }
    const transfer = clips.flatMap((clip) => clip.audio.map((channel) => channel.buffer))
    worker.postMessage({ clips } satisfies FilmWorkerRequest, transfer)
  })
}
