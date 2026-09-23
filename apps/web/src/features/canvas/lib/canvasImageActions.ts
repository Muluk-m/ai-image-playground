import { i18next } from '../../../i18n'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { copyBlobToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { downloadBlob } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import type { CanvasDoc } from './canvasDoc'

/**
 * 画布图片元素的位图来源。可能是 dataURL，也可能是云端项目的 `aip-media:` 标识——
 * `dataUrlToBlob` 内部会 `resolveMediaSource`，所以两种都能直接往下传。
 */
export function canvasImageSource(doc: CanvasDoc, id: string): string | undefined {
  const element = doc.getElement(id)
  return element?.type === 'image' ? doc.files[element.fileId] : undefined
}

/**
 * 复制与下载的**唯一实现**：右键菜单与选中工具条是同一个动作的两个入口，
 * 各写一份必然在错误提示、扩展名推断这类细节上分叉。反馈（toast）也放在这里，
 * 免得两个调用方对同一次失败说两种话。
 */
export async function copyCanvasImage(dataUrl: string): Promise<void> {
  const { showToast } = useStore.getState()
  try {
    await copyBlobToClipboard(await dataUrlToBlob(dataUrl))
    showToast(i18next.t('imageMenu.copied', { ns: 'canvas' }), 'success')
  } catch (err) {
    showToast(
      getClipboardFailureMessage(i18next.t('toast.copyFailed', { ns: 'common' }), err),
      'error',
    )
  }
}

export async function downloadCanvasImage(dataUrl: string, elementId: string): Promise<void> {
  try {
    const blob = await dataUrlToBlob(dataUrl)
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
    downloadBlob(blob, `canvas-${elementId}.${ext}`)
  } catch {
    useStore.getState().showToast(i18next.t('imageMenu.downloadFailed', { ns: 'canvas' }), 'error')
  }
}
