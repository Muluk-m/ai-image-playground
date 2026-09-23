/**
 * 拖进来的东西摊平成文件：**文件夹要走进去**。
 *
 * `DataTransfer.files` 只给顶层文件，拖一个文件夹进来它是空的（拖进来的是目录条目，
 * 不是文件），用户看到的就是「拖了没反应」。目录得靠 `webkitGetAsEntry` 递归读。
 *
 * 两条硬约束：
 * 1. `DataTransferItemList` 在 drop 处理函数返回后就失效，**entry 必须同步取完**，
 *    之后才能 await。
 * 2. 目录读取分页：`readEntries` 一次只给一批（Chrome 100 个），读到空数组才算完。
 */

const MAX_FILES = 500
const MAX_DEPTH = 8

export interface DroppedItems {
  readonly entries: readonly FileSystemEntry[]
  readonly files: readonly File[]
}

/** drop 事件里同步抓下条目：异步之后这张表就空了。 */
export function dropEntries(transfer: DataTransfer): DroppedItems {
  const entries: FileSystemEntry[] = []
  // items 不是必然在场：老浏览器与测试里的合成事件只给 files，硬遍历会当场抛。
  const items = transfer.items as DataTransferItemList | undefined
  for (let i = 0; i < (items?.length ?? 0); i += 1) {
    const entry = items?.[i]?.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  return { entries, files: [...transfer.files] }
}

// Promise.withResolvers 要 es2024 lib，本仓库的 target 还没到；这三处是回调式 API 的转接。
function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    )
  })
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (batch) => resolve([...batch]),
      () => resolve([]),
    )
  })
}

async function walk(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry)
    if (file) out.push(file)
    return
  }
  if (!entry.isDirectory || depth >= MAX_DEPTH) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries 一次只给一批，读到空数组才是读完。
  for (;;) {
    const batch = await readBatch(reader)
    if (batch.length === 0) return
    for (const child of batch) {
      await walk(child, depth + 1, out)
      if (out.length >= MAX_FILES) return
    }
  }
}

/**
 * 摊平 drop 里的所有文件，文件夹递归展开。`dropEntries` 的结果要在 drop 处理函数里
 * **同步**取好再传进来。浏览器不给 entry API 时退回顶层文件。
 */
export async function expandDroppedFiles(dropped: DroppedItems): Promise<File[]> {
  if (dropped.entries.length === 0) return [...dropped.files]
  const out: File[] = []
  for (const entry of dropped.entries) {
    await walk(entry, 0, out)
    if (out.length >= MAX_FILES) break
  }
  // entry 一个都读不出来（权限、协议限制）时别把这次拖拽吞掉。
  return out.length > 0 ? out : [...dropped.files]
}
