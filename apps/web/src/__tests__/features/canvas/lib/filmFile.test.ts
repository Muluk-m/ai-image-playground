import { afterEach, expect, it, vi } from 'vitest'
import { createFilmFile } from '../../../../features/canvas/lib/filmFile'

function setup() {
  const stream = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  }
  const file = new Blob(['finished mp4'])
  const handle = { createWritable: vi.fn(async () => stream), getFile: vi.fn(async () => file) }
  const now = Date.now()
  const stale = `${now - 2 * 86400000}-old.mp4`,
    recent = `${now}-other-tab.mp4`
  const directory = {
    async *entries() {
      yield [stale]
      yield [recent]
    },
    removeEntry: vi.fn(async () => {}),
    getFileHandle: vi.fn(async (_name: string, _options: { create: boolean }) => handle),
  }
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
  })
  return { stream, file, handle, directory, stale }
}
afterEach(() => vi.unstubAllGlobals())

it('closes before exposing the disk snapshot and preserves recent files for queued downloads', async () => {
  const { stream, handle, directory, stale } = setup()
  const output = await createFilmFile()
  expect(directory.removeEntry).toHaveBeenCalledExactlyOnceWith(stale)
  const chunk = { type: 'write' as const, position: 4, data: new Uint8Array([1, 2]) }
  await output.write(chunk)
  expect(stream.write).toHaveBeenCalledWith(chunk)
  const blob = await output.finish()
  expect(blob.type).toBe('video/mp4')
  expect(stream.close.mock.invocationCallOrder[0]).toBeLessThan(
    handle.getFile.mock.invocationCallOrder[0]!,
  )
  expect(directory.removeEntry).toHaveBeenCalledTimes(1)
})

it('waits for an outstanding write before aborting and removing partial output', async () => {
  const { stream, directory } = setup()
  let finish!: () => void
  stream.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const output = await createFilmFile()
  const writing = output.write({ type: 'write', position: 0, data: new Uint8Array(1) })
  await Promise.resolve()
  const discarding = output.discard()
  expect(stream.abort).not.toHaveBeenCalled()
  finish()
  await writing
  await discarding
  expect(stream.abort).toHaveBeenCalledOnce()
  expect(directory.removeEntry).toHaveBeenLastCalledWith(directory.getFileHandle.mock.calls[0]![0])
})
