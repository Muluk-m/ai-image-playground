import { i18next } from '../i18n'

export { copyTextToClipboard } from './clipboardText'

export async function copyBlobToClipboard(blob: Blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image API is not available')
  }

  // Chromium 的 ClipboardItem 只接受 image/png 图片；webp / jpeg（如任务参数选了
  // WEBP 格式的生成结果）直接写会抛 NotAllowedError（Write permission denied）。
  const payload =
    blob.type.startsWith('image/') && blob.type !== 'image/png'
      ? await transcodeImageBlobToPng(blob)
      : blob
  await navigator.clipboard.write([new ClipboardItem({ [payload.type]: payload })])
}

async function transcodeImageBlobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(i18next.t('canvas.unsupported', { ns: 'lib' }))
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error(i18next.t('image.transcodeFailed', { ns: 'lib' }))),
        'image/png',
      )
    })
  } finally {
    bitmap.close()
  }
}

export function getClipboardFailureMessage(fallback: string, err: unknown) {
  if (isEmbeddedPage() && isClipboardPermissionError(err)) {
    return i18next.t('clipboard.iframeDenied', { ns: 'lib' })
  }

  return fallback
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function isClipboardPermissionError(err: unknown) {
  if (!(err instanceof Error)) return false

  return (
    err.name === 'NotAllowedError' ||
    /permission|permissions policy|not allowed|denied/i.test(err.message)
  )
}
