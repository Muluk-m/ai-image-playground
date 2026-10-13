import { authenticatedBffFetch } from '../../../lib/authClient'
import { videoOutputUrl } from '../../../lib/channels/queueClient'
import { createFilmFile, filmStorageSupported } from './filmFile'
import { composeInWorker, decodeClipAudio, FilmExportError } from './filmPipeline'
import type { FilmClip } from './filmSpec'
import { zipFilmClips } from './filmZip'

export { FilmExportError, type FilmExportFailure } from './filmPipeline'

export type FilmExportPhase = 'fetching' | 'encoding'

let support: Promise<boolean> | null = null

/** 这个浏览器能不能在 Worker 里编出 H.264 + AAC。结果只探一次。 */
export function filmExportSupported(): Promise<boolean> {
  support ??= (async () => {
    if (
      typeof VideoEncoder === 'undefined' ||
      typeof AudioEncoder === 'undefined' ||
      typeof OffscreenCanvas === 'undefined' ||
      typeof Worker === 'undefined' ||
      !filmStorageSupported()
    )
      return false
    const { canEncodeAudio, canEncodeVideo } = await import('mediabunny')
    const [video, audio] = await Promise.all([
      canEncodeVideo('avc', { width: 1920, height: 1080 }).catch(() => false),
      canEncodeAudio('aac').catch(() => false),
    ])
    return video && audio
  })()
  return support
}

async function fetchClip(clip: FilmClip, position: number, signal: AbortSignal): Promise<Blob> {
  let res: Response
  try {
    res = await authenticatedBffFetch(videoOutputUrl(clip), { signal })
  } catch (err) {
    if (signal.aborted) throw err
    throw new FilmExportError('fetch', position)
  }
  if (!res.ok) throw new FilmExportError('fetch', position)
  return res.blob()
}

/** 逐段获取与解码，Worker 输出带背压写入 OPFS，返回磁盘支持的 Blob。 */
export async function exportFilm(
  clips: readonly FilmClip[],
  options: {
    signal: AbortSignal
    onProgress: (phase: FilmExportPhase, fraction: number) => void
  },
): Promise<Blob> {
  const { signal, onProgress } = options
  signal.throwIfAborted()
  const file = await createFilmFile()
  try {
    signal.throwIfAborted()
    const worker = new Worker(new URL('./filmWorker.ts', import.meta.url), { type: 'module' })
    await composeInWorker(worker, clips.length, signal, {
      async loadClip(index) {
        onProgress('fetching', index / clips.length)
        const clip = clips[index]!
        const blob = await fetchClip(clip, index + 1, signal)
        signal.throwIfAborted()
        const audio = await decodeClipAudio(blob, clip)
        signal.throwIfAborted()
        return { blob, in: clip.in, ...(clip.out === undefined ? {} : { out: clip.out }), audio }
      },
      write: (chunk) => file.write(chunk),
      onProgress: (fraction) => onProgress('encoding', fraction),
    })
    signal.throwIfAborted()
    const blob = await file.finish()
    signal.throwIfAborted()
    return blob
  } catch (error) {
    await file.discard()
    throw error
  }
}

/** 不能编码时的回退：把各段原片按时间线顺序打成一个 zip，不裁剪、不重编码。 */
export async function zipTimelineClips(
  clips: readonly FilmClip[],
  signal: AbortSignal,
): Promise<Blob> {
  return zipFilmClips(
    clips.map((clip, index) => ({
      name: `${String(index + 1).padStart(2, '0')}-${clip.taskId}.mp4`,
      load: () => fetchClip(clip, index + 1, signal),
    })),
    signal,
  )
}
