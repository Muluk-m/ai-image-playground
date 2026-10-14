/// <reference lib="dom.asynciterable" />
import type { StreamTargetChunk } from 'mediabunny'

const KEEP_MS = 24 * 60 * 60 * 1000

export function filmStorageSupported(): boolean {
  return (
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  )
}

/** OPFS 原件保留一天，下载排队期间不能删掉 getFile() 返回的磁盘快照。 */
export async function createFilmFile() {
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle('film-exports', { create: true })
  for await (const [name] of directory.entries()) {
    const timestamp = Number(name.split('-')[0])
    if (timestamp > 0 && Date.now() - timestamp > KEEP_MS)
      await directory.removeEntry(name).catch(() => {})
  }
  const name = `${Date.now()}-${crypto.randomUUID()}.mp4`
  const handle = await directory.getFileHandle(name, { create: true })
  let stream: FileSystemWritableFileStream
  try {
    stream = await handle.createWritable()
  } catch (error) {
    await directory.removeEntry(name).catch(() => {})
    throw error
  }
  let pending = Promise.resolve()
  return {
    write(chunk: StreamTargetChunk) {
      pending = pending.then(() => stream.write(chunk))
      return pending
    },
    async finish(contentType = 'video/mp4'): Promise<Blob> {
      await pending
      await stream.close()
      const file = await handle.getFile()
      return file.slice(0, file.size, contentType)
    },
    async discard() {
      await pending.catch(() => {})
      await stream.abort().catch(() => {})
      await directory.removeEntry(name).catch(() => {})
    },
  }
}
