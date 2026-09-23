import { zipSync } from 'fflate'
import { i18next } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { downloadBlob } from '../../../lib/downloadImages'
import {
  referenceAdmission,
  referenceRefusal,
  referenceRefusalMessage,
  referenceTally,
} from '../../../lib/referenceDraft'
import { storeImageFromFile, useStore } from '../../../store'
import type { InputImage } from '../../../types'
import { uniqueFileNames } from './naming'

export interface DeliverableImage {
  name: string
  blob: Blob
}

/**
 * 一张直接落盘，多张打成一个 ZIP。
 * 多张不逐个 `a.click()`——浏览器把连续下载当成滥用，只保留最后一次，用户点「下载全部」只拿到一张。
 * ZIP 不压缩（`level: 0`）：图片已经是压缩格式，再压一遍只换来几秒主线程卡顿。
 */
export async function downloadImages(
  images: readonly DeliverableImage[],
  zipName: string,
): Promise<void> {
  if (images.length === 0) return
  if (images.length === 1) {
    downloadBlob(images[0].blob, images[0].name)
    return
  }
  const names = uniqueFileNames(images.map((image) => image.name))
  const files: Record<string, Uint8Array> = {}
  for (const [index, image] of images.entries())
    files[names[index]] = new Uint8Array(await image.blob.arrayBuffer())
  downloadBlob(
    new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }),
    zipName,
  )
}

/**
 * 放入创作输入框：产物变成 File 走和「上传一张图」同一条路。
 * 工具箱的中间产物只活在内存里，只有用户按下这颗按钮的那几张才会落进 IndexedDB——
 * 所以先问一次参考图准入，整把放不下就一张都不存，免得为几张进不去的图白写 image store。
 */
export async function sendImagesToComposer(images: readonly DeliverableImage[]): Promise<void> {
  if (images.length === 0) return
  const { attachInputImages, inputImages, settings, setAppMode, showToast } = useStore.getState()
  const admission = referenceAdmission(getActiveApiProfile(settings))
  const refusal = referenceRefusal(
    referenceTally(inputImages, admission),
    { total: images.length },
    admission,
  )
  if (refusal) {
    showToast(referenceRefusalMessage(refusal), 'error')
    return
  }
  const stored: InputImage[] = []
  for (const image of images)
    stored.push(
      await storeImageFromFile(new File([image.blob], image.name, { type: image.blob.type })),
    )
  if (!attachInputImages(stored, admission)) return
  setAppMode('image')
  showToast(i18next.t('composer.sent', { ns: 'toolbox', count: images.length }), 'success')
}
