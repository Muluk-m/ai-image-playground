import { zipSync } from 'fflate'
import { i18next } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { downloadBlob } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import type { CanvasDoc, ImageEl } from './canvasDoc'
import { canvasElementCreatedAt, canvasImageName } from './imageInfo'

/** 文件名里不能留的字符（Windows 最严），以及控制字符。 */
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g
/** 名字多半是整条提示词，截断到这个长度，扩展名另算。 */
const MAX_NAME_LENGTH = 60
/** 名字里原本就带着的媒体扩展名（多半来自导入时的文件名）。 */
const MEDIA_EXTENSION = /\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov)$/i

export interface CanvasExportResult {
  /** 落到本地的文件数（打包时即包里的条目数）。 */
  exported: number
  /** 取不到位图 / 取不到 mp4 的条目数，导出仍然继续。 */
  failed: number
}

export interface CanvasExportOptions {
  /** 打包时的 zip 文件名（不含扩展名），通常是项目名。 */
  baseName?: string
  /** 每取完一件回调一次，供界面显示「导出中 3/12」。 */
  onProgress?: (done: number, total: number) => void
}

/** 把任意名字收成一个安全文件名（不含扩展名）；空名字回退到 `image`。 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(UNSAFE_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return cleaned || 'image'
}

/**
 * 落盘文件名：扩展名按真实字节给，名字里原有的媒体扩展名先去掉。
 * 导入的图片名字本来就是 `foo.png`，不去掉会得到 `foo.png.png`；
 * 原名是 `.jpeg`、字节是 jpg 时也只保留后者这一个。
 */
function withExtension(base: string, ext: string): string {
  return `${base.replace(MEDIA_EXTENSION, '') || 'image'}.${ext}`
}

/**
 * 可以导出的画布元素：带位图的图片，以及画布上的视频节点（导出的是服务端那份 mp4，
 * 不是封面位图）。标注、时间线、还在跑的占位框都不是产物，不参与导出。
 * 顺序按生成时间、同时间按横坐标——批量导出的编号要和用户在画布上读到的顺序一致。
 */
export function exportableElements(doc: CanvasDoc, ids?: Iterable<string>): ImageEl[] {
  const wanted = ids ? new Set(ids) : null
  return doc.elements
    .filter(
      (el): el is ImageEl =>
        el.type === 'image' &&
        (!wanted || wanted.has(el.id)) &&
        (Boolean(el.video) || Boolean(doc.files[el.fileId])),
    )
    .sort((a, b) => canvasElementCreatedAt(a) - canvasElementCreatedAt(b) || a.x - b.x)
}

/** 一件产物的字节。取不到（位图缺失、mp4 拉不下来）返回 null，由调用方计入 failed。 */
async function elementBlob(
  doc: CanvasDoc,
  element: ImageEl,
): Promise<{ blob: Blob; ext: string } | null> {
  try {
    if (element.video) {
      // 播放地址要带登录态，不能直接交给 <a href>。
      const res = await authenticatedBffFetch(
        queueOutputUrl(element.video.taskId, element.video.outputIndex),
      )
      if (!res.ok) return null
      return { blob: await res.blob(), ext: 'mp4' }
    }
    const source = doc.files[element.fileId]
    if (!source) return null
    const blob = await dataUrlToBlob(source)
    return { blob, ext: blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png' }
  } catch (err) {
    console.warn('[canvas] 导出条目失败', err)
    return null
  }
}

/**
 * 批量导出画布产物：一件直接落盘，多件打成一个 zip。
 *
 * 多件时不逐个 `a.click()`——浏览器会把连续下载当成滥用，只保留最后一次，
 * 用户点「导出 12 张」最后只拿到一张。zip 不压缩（`level: 0`）：png / jpeg / mp4
 * 已经是压缩格式，再压一遍只换来几秒的主线程卡顿。
 */
export async function exportCanvasImages(
  doc: CanvasDoc,
  ids: Iterable<string> | undefined,
  opts: CanvasExportOptions = {},
): Promise<CanvasExportResult> {
  const elements = exportableElements(doc, ids)
  if (elements.length === 0) return { exported: 0, failed: 0 }

  const files: Record<string, Uint8Array> = {}
  const single: Array<{ blob: Blob; name: string }> = []
  let failed = 0
  for (const [index, element] of elements.entries()) {
    const fetched = await elementBlob(doc, element)
    opts.onProgress?.(index + 1, elements.length)
    if (!fetched) {
      failed += 1
      continue
    }
    const named = withExtension(safeFileName(canvasImageName(element)), fetched.ext)
    if (elements.length === 1) {
      single.push({ blob: fetched.blob, name: named })
      continue
    }
    // 序号前缀让 zip 里的顺序等于画布上的顺序；一次生成的几张图名字都是同一条提示词，
    // 前缀同时是它们的去重位，否则后一张会把前一张覆盖掉。
    files[`${String(index + 1).padStart(2, '0')}-${named}`] = new Uint8Array(
      await fetched.blob.arrayBuffer(),
    )
  }

  const lone = single[0]
  if (lone) {
    downloadBlob(lone.blob, lone.name)
    return { exported: 1, failed }
  }
  const exported = Object.keys(files).length
  if (exported === 0) return { exported: 0, failed }
  const zip = new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' })
  downloadBlob(zip, `${safeFileName(opts.baseName ?? 'canvas')}.zip`)
  return { exported, failed }
}

/**
 * 批量导出 + 统一的结果反馈：画布上的批量条与作品弹窗是同一件事的两个入口，
 * 文案只有一份，免得两处对「部分失败」说不一样的话。
 */
export async function exportCanvasSelection(
  doc: CanvasDoc,
  ids: Iterable<string> | undefined,
  opts: CanvasExportOptions = {},
): Promise<CanvasExportResult> {
  const result = await exportCanvasImages(doc, ids, opts)
  const { showToast } = useStore.getState()
  if (result.exported === 0) showToast(i18next.t('batch.exportFailed', { ns: 'canvas' }), 'error')
  else if (result.failed > 0)
    showToast(
      i18next.t('batch.exportPartial', {
        ns: 'canvas',
        count: result.exported,
        failed: result.failed,
      }),
      'info',
    )
  else showToast(i18next.t('batch.exportDone', { ns: 'canvas', count: result.exported }), 'success')
  return result
}
