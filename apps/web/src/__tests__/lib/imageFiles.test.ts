// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { acceptImageFiles, collectDroppedFiles } from '../../lib/imageFiles'
import { MAX_IMAGE_BYTES } from '../../lib/inputImageLimit'
import { useStore } from '../../store'

function image(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

beforeEach(() => {
  useStore.setState({ showToast: vi.fn() })
})

it('太大的图在进输入框之前就拦下来，其余照收', () => {
  const ok = image('ok.png', MAX_IMAGE_BYTES)
  const huge = image('huge.png', MAX_IMAGE_BYTES + 1)

  expect(acceptImageFiles([ok, huge])).toEqual([ok])
  expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
})

it('非图片与超大图各提示一次', () => {
  const text = new File(['x'], 'a.txt', { type: 'text/plain' })

  expect(acceptImageFiles([text, image('huge.png', MAX_IMAGE_BYTES + 1)])).toEqual([])
  expect(useStore.getState().showToast).toHaveBeenCalledTimes(2)
})

it('有图留下时，非图片按个数提示跳过了几个', () => {
  const png = image('a.png', 1)
  const files = [png, new File(['x'], 'a.txt'), new File(['x'], 'b.pdf')]

  expect(acceptImageFiles(files)).toEqual([png])
  expect(useStore.getState().showToast).toHaveBeenCalledWith('已跳过 2 个非图片文件', 'error')
})

/** 最小的 FileSystemEntry 替身：目录的 readEntries 按批返回，最后一批是空的。 */
function fileEntry(file: File): FileSystemEntry {
  return {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => ok(file),
  } as unknown as FileSystemEntry
}
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      // 分两批给，模拟 Chrome 每批最多 100 条：只读一批会丢文件。
      const batches = [children.slice(0, 1), children.slice(1), []]
      return { readEntries: (ok: (b: FileSystemEntry[]) => void) => ok(batches.shift() ?? []) }
    },
  } as unknown as FileSystemEntry
}
function transfer(entries: FileSystemEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files: [],
  } as unknown as DataTransfer
}

it('拖入文件夹：递归解开子文件夹、跨批读完、丢掉系统文件，并带回文件夹名', async () => {
  const a = image('2.png', 1)
  const b = image('10.png', 1)
  const nested = image('deep.jpg', 1)
  const note = new File(['x'], 'notes.txt')
  const root = dirEntry('产品A', [
    fileEntry(b),
    fileEntry(new File(['x'], '.DS_Store')),
    fileEntry(a),
    fileEntry(note),
    dirEntry('sub', [fileEntry(nested)]),
  ])

  const { files, folder } = await collectDroppedFiles(transfer([root]))

  expect(folder).toBe('产品A')
  // 按名字自然排序（2 在 10 前面）；非图片留给 acceptImageFiles 去提示，系统文件在这一步就没了。
  expect(files).toEqual([a, b, note, nested])
  expect(acceptImageFiles(files)).toEqual([a, b, nested])
})

it('拖入的是散文件或多个文件夹时不给文件夹名', async () => {
  const a = image('a.png', 1)
  const result = await collectDroppedFiles(
    transfer([fileEntry(a), dirEntry('x', [fileEntry(image('b.png', 1))])]),
  )
  expect(result.folder).toBeNull()
  expect(result.files).toHaveLength(2)
})
