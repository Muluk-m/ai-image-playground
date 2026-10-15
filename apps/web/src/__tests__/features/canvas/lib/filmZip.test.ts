import { unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'

const { supported, createFile } = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  createFile: vi.fn(),
}))
vi.mock('../../../../features/canvas/lib/filmFile', () => ({
  filmStorageSupported: supported,
  createFilmFile: createFile,
}))

import { zipFilmClips } from '../../../../features/canvas/lib/filmZip'

afterEach(() => vi.clearAllMocks())
it('streams a valid ordered archive while retaining raw clip bytes', async () => {
  const chunks: Uint8Array[] = []
  createFile.mockResolvedValue({
    write: async ({ data }: { data: Uint8Array }) => {
      chunks.push(data)
    },
    finish: async (type: string) => new Blob(chunks as BlobPart[], { type }),
    discard: vi.fn(),
  })
  const output = await zipFilmClips(
    [
      { name: '01-a.mp4', load: async () => new Blob(['original A']) },
      { name: '02-b.mp4', load: async () => new Blob(['original B']) },
    ],
    new AbortController().signal,
  )
  const files = unzipSync(new Uint8Array(await output.arrayBuffer()))
  expect(Object.keys(files)).toEqual(['01-a.mp4', '02-b.mp4'])
  expect(new TextDecoder().decode(files['02-b.mp4'])).toBe('original B')
  expect(output.type).toBe('application/zip')
})
it('cancels between disk chunks without fetching another source', async () => {
  const controller = new AbortController(),
    discard = vi.fn()
  createFile.mockResolvedValue({
    write: async () => {
      controller.abort()
    },
    finish: vi.fn(),
    discard,
  })
  const next = vi.fn(async () => new Blob(['next']))
  await expect(
    zipFilmClips(
      [
        { name: '01-a.mp4', load: async () => new Blob([new Uint8Array(2 ** 21)]) },
        { name: '02-b.mp4', load: next },
      ],
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(next).not.toHaveBeenCalled()
  expect(discard).toHaveBeenCalledOnce()
})
it('retains download fallback when the browser lacks OPFS', async () => {
  supported.mockReturnValueOnce(false)
  const output = await zipFilmClips(
    [{ name: 'a.mp4', load: async () => new Blob(['raw']) }],
    new AbortController().signal,
  )
  expect(
    new TextDecoder().decode(unzipSync(new Uint8Array(await output.arrayBuffer()))['a.mp4']),
  ).toBe('raw')
  expect(createFile).not.toHaveBeenCalled()
})

it('rejects oversized original clips before returning an invalid non-ZIP64 archive', async () => {
  const discard = vi.fn(),
    write = vi.fn()
  createFile.mockResolvedValue({ write, finish: vi.fn(), discard })
  const oversized = new Blob(['raw'])
  Object.defineProperty(oversized, 'size', { value: 0xffffffff })
  await expect(
    zipFilmClips(
      [{ name: 'large.mp4', load: async () => oversized }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: 'zipTooLarge' })
  expect(write).not.toHaveBeenCalled()
  expect(discard).toHaveBeenCalledOnce()
})
