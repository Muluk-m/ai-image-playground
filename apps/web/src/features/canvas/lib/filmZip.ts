import { Zip, ZipPassThrough } from 'fflate'
import { createFilmFile, filmStorageSupported } from './filmFile'
import { FilmExportError } from './filmPipeline'

/** 原片逐段、分块打包；老浏览器没有 OPFS 时保留 Blob 下载回退。 */
export async function zipFilmClips(
  clips: readonly { name: string; load: () => Promise<Blob> }[],
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted()
  // fflate 写端不生成 ZIP64；拒绝超限原片，不能返回损坏的归档。
  if (clips.length >= 65535) throw new FilmExportError('zipTooLarge')
  const file = filmStorageSupported() ? await createFilmFile() : undefined
  const parts: Blob[] = []
  let pending = Promise.resolve(),
    position = 0
  let failure: Error | undefined
  const zip = new Zip((error, data) => {
    if (error) {
      failure = error
      return
    }
    if (position + data.length >= 0xffffffff) {
      failure = new FilmExportError('zipTooLarge')
      return
    }
    if (file) {
      const chunk = { type: 'write' as const, position, data: data.slice() }
      pending = pending.then(() => file.write(chunk))
      // 数据推送同步触发回调；下方每块都会等待 pending 并传播错误。
      void pending.catch(() => {})
    } else parts.push(new Blob([data as BlobPart]))
    position += data.length
  })
  try {
    for (const clip of clips) {
      signal.throwIfAborted()
      const blob = await clip.load()
      signal.throwIfAborted()
      if (blob.size + position >= 0xffffffff) throw new FilmExportError('zipTooLarge')
      const entry = new ZipPassThrough(clip.name)
      zip.add(entry)
      // Blob.slice 限制每次复制的原片大小，也兼容缺少 Blob.stream 的旧浏览器。
      for (let offset = 0; offset < blob.size; offset += 2 ** 20) {
        signal.throwIfAborted()
        const data = new Uint8Array(await blob.slice(offset, offset + 2 ** 20).arrayBuffer())
        signal.throwIfAborted()
        entry.push(data, false)
        await pending
        if (failure) throw failure
      }
      entry.push(new Uint8Array(), true)
      await pending
      if (failure) throw failure
    }
    signal.throwIfAborted()
    zip.end()
    await pending
    if (failure) throw failure
    signal.throwIfAborted()
    const result = file
      ? await file.finish('application/zip')
      : new Blob(parts, { type: 'application/zip' })
    signal.throwIfAborted()
    return result
  } catch (error) {
    zip.terminate()
    await pending.catch(() => {})
    await file?.discard()
    throw error
  }
}
