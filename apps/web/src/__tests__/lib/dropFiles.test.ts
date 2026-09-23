// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { type DroppedItems, expandDroppedFiles } from '../../lib/dropFiles'

const file = (name: string) => new File(['x'], name, { type: 'image/png' })

function fileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    file: (onSuccess: (f: File) => void) => onSuccess(file(name)),
  } as unknown as FileSystemEntry
}

/** 目录读取是分页的：第一次给一批，第二次给空数组才算读完。 */
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      let done = false
      return {
        readEntries: (onSuccess: (entries: FileSystemEntry[]) => void) => {
          const batch = done ? [] : children
          done = true
          onSuccess(batch)
        },
      }
    },
  } as unknown as FileSystemEntry
}

const dropped = (entries: FileSystemEntry[], files: File[] = []): DroppedItems => ({
  entries,
  files,
})

/**
 * 拖文件夹进来时 `DataTransfer.files` 是空的——只认它就等于「拖了没反应」。
 */
describe('expandDroppedFiles', () => {
  it('walks into folders, including nested ones', async () => {
    const tree = dirEntry('shoot', [
      fileEntry('a.png'),
      dirEntry('raw', [fileEntry('b.png'), fileEntry('c.png')]),
    ])

    const files = await expandDroppedFiles(dropped([tree]))

    expect(files.map((one) => one.name)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('keeps reading a directory until a batch comes back empty', async () => {
    // 一次 readEntries 只给一批：见好就收会静默丢掉后面的图。
    let calls = 0
    const paged = {
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (onSuccess: (entries: FileSystemEntry[]) => void) => {
          calls += 1
          onSuccess(calls <= 2 ? [fileEntry(`page${calls}.png`)] : [])
        },
      }),
    } as unknown as FileSystemEntry

    const files = await expandDroppedFiles(dropped([paged]))

    expect(files.map((one) => one.name)).toEqual(['page1.png', 'page2.png'])
  })

  it('falls back to the plain file list where the entry API gives nothing', async () => {
    const plain = file('dropped.png')

    expect(await expandDroppedFiles(dropped([], [plain]))).toEqual([plain])
    // entry 在场却一个文件都读不出来（权限、协议限制）时也不能把这次拖拽吞掉。
    const empty = dirEntry('locked', [])
    expect(await expandDroppedFiles(dropped([empty], [plain]))).toEqual([plain])
  })
})
