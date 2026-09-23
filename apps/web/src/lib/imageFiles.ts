import { i18next } from '../i18n'
import { useStore } from '../store'
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB } from './inputImageLimit'

/**
 * 拖入、粘贴或从文件夹选进来的一堆文件里只留图片，太大的也丢掉；丢掉的那些各提示一次。
 * 一张图都没剩就说「只支持图片」；剩下了就说跳过了几个，免得用户以为整个文件夹都没进来。
 */
export function acceptImageFiles(files: readonly File[]): File[] {
  const images = files.filter((file) => file.type.startsWith('image/'))
  const skipped = files.length - images.length
  if (skipped > 0) {
    useStore
      .getState()
      .showToast(
        images.length > 0
          ? i18next.t('image.skippedNonImages', { ns: 'lib', count: skipped })
          : i18next.t('image.onlyImages', { ns: 'lib' }),
        'error',
      )
  }
  const sized = images.filter((file) => file.size <= MAX_IMAGE_BYTES)
  if (sized.length < images.length) {
    useStore.getState().showToast(
      i18next.t('image.tooLarge', {
        ns: 'lib',
        count: images.length - sized.length,
        max: MAX_IMAGE_MB,
      }),
      'error',
    )
  }
  return sized
}

/**
 * 系统自己塞进文件夹的东西（`.DS_Store`、`._xxx`、`Thumbs.db`）：用户没放过它们，
 * 为它们弹「跳过了非图片」只会让人困惑，所以悄悄丢掉。
 */
function isSystemFile(name: string): boolean {
  return name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini'
}

/** 从文件夹选择器拿到的文件：带相对路径，按路径排序，与资源管理器里看到的顺序一致。 */
export function filesFromFolderInput(list: FileList | null): {
  files: File[]
  folder: string | null
} {
  const files = [...(list ?? [])]
    .filter((file) => !isSystemFile(file.name))
    .sort((a, b) =>
      a.webkitRelativePath.localeCompare(b.webkitRelativePath, undefined, { numeric: true }),
    )
  const folder = files[0]?.webkitRelativePath.split('/')[0] || null
  return { files, folder }
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries 一次最多给一批（Chrome 是 100 条），读到空批才算读完。
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all)
        else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

async function walkEntry(entry: FileSystemEntry): Promise<File[]> {
  if (isSystemFile(entry.name)) return []
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    )
    return [file]
  }
  if (!entry.isDirectory) return []
  const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const nested = await Promise.all(children.map(walkEntry))
  return nested.flat()
}

/**
 * 拖进来的东西展开成文件：文件夹递归解开（子文件夹也算）。
 * `folder` 只在恰好拖进一个文件夹时给出，用来给这组图起默认名。
 *
 * 必须在 drop 事件里同步调用：`DataTransfer.items` 在事件返回后即失效，
 * 所以这里先同步取出 entry，之后才进入异步遍历。
 */
export function collectDroppedFiles(
  data: DataTransfer,
): Promise<{ files: File[]; folder: string | null }> {
  const entries = [...(data.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
  // 不支持 entry API（或拖的不是文件系统里的东西）：退回平铺文件列表，行为与以前一致。
  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return Promise.resolve({
      files: [...data.files].filter((file) => !isSystemFile(file.name)),
      folder: null,
    })
  }
  const roots = entries as FileSystemEntry[]
  const folder = roots.length === 1 && roots[0]!.isDirectory ? roots[0]!.name : null
  return Promise.all(roots.map(walkEntry)).then((nested) => ({ files: nested.flat(), folder }))
}
