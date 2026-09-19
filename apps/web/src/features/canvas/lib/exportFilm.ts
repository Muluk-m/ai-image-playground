import { zipSync } from 'fflate'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import type { ComposeClip } from './composeFilm'
import { composeInWorker, decodeClipAudio, FilmExportError } from './filmPipeline'
import type { FilmClip } from './filmSpec'

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
      typeof Worker === 'undefined'
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
    res = await authenticatedBffFetch(queueOutputUrl(clip.taskId, clip.outputIndex), { signal })
  } catch (err) {
    if (signal.aborted) throw err
    throw new FilmExportError('fetch', position)
  }
  if (!res.ok) throw new FilmExportError('fetch', position)
  return res.blob()
}

/**
 * 把一条时间线合成成 mp4：先逐段下载源片、解出音轨，再交给 Worker 编码。
 * 进度：下载占前 20%，编码占后 80%。
 */
export async function exportFilm(
  clips: readonly FilmClip[],
  options: {
    signal: AbortSignal
    onProgress: (phase: FilmExportPhase, fraction: number) => void
  },
): Promise<Blob> {
  const { signal, onProgress } = options
  const prepared: ComposeClip[] = []
  onProgress('fetching', 0)
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i]!
    const blob = await fetchClip(clip, i + 1, signal)
    signal.throwIfAborted()
    const audio = await decodeClipAudio(blob, clip)
    signal.throwIfAborted()
    prepared.push({
      blob,
      in: clip.in,
      ...(clip.out === undefined ? {} : { out: clip.out }),
      audio,
    })
    onProgress('fetching', ((i + 1) / clips.length) * 0.2)
  }
  const worker = new Worker(new URL('./filmWorker.ts', import.meta.url), { type: 'module' })
  const buffer = await composeInWorker(worker, prepared, signal, (fraction) =>
    onProgress('encoding', 0.2 + fraction * 0.8),
  )
  return new Blob([buffer], { type: 'video/mp4' })
}

/** 不能编码时的回退：把各段原片按时间线顺序打成一个 zip，不裁剪、不重编码。 */
export async function zipTimelineClips(
  clips: readonly FilmClip[],
  signal: AbortSignal,
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {}
  for (let i = 0; i < clips.length; i += 1) {
    const blob = await fetchClip(clips[i]!, i + 1, signal)
    files[`${String(i + 1).padStart(2, '0')}-${clips[i]!.taskId}.mp4`] = new Uint8Array(
      await blob.arrayBuffer(),
    )
  }
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' })
}
