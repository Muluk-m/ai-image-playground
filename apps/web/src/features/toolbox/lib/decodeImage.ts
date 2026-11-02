import { canvasToBlob } from '../../../lib/canvasImage'
import { isHeicFile } from '../../../lib/heicImage'
import { MAX_IMAGE_BYTES } from '../../../lib/inputImageLimit'
import { CanvasLimitError, currentCanvasLimits, exceedsCanvasLimits } from './canvasLimits'

let heicGate: Promise<void> = Promise.resolve()
function decodeInWorker(file: File): Promise<ImageBitmap> {
  // Chrome 80 / Safari 14 的目标运行时没有 Promise.withResolvers。
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heicDecoder.worker.ts', import.meta.url), {
      type: 'module',
    })
    const finish = () => {
      clearTimeout(timeout)
      worker.terminate()
    }
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('heic_decode_timeout'))
    }, 45_000)
    worker.onmessage = (event: MessageEvent<{ bitmap: ImageBitmap } | { error: string }>) => {
      finish()
      if ('bitmap' in event.data) resolve(event.data.bitmap)
      else reject(new Error(event.data.error))
    }
    worker.onerror = () => {
      finish()
      reject(new Error('heic_decode_failed'))
    }
    worker.postMessage(file)
  })
}

async function decodeHeic(file: File): Promise<{ bitmap: ImageBitmap; preview: Blob }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image_too_large')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // 独立 Worker 按需下载 CSP 解码器；结束时连同库内 Worker 一起释放。
    bitmap = await decodeInWorker(file)
  }
  const canvas = document.createElement('canvas')
  try {
    if (exceedsCanvasLimits(bitmap.width, bitmap.height, currentCanvasLimits()))
      throw new CanvasLimitError(bitmap.width, bitmap.height)
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d context unavailable')
    context.drawImage(bitmap, 0, 0)
    // 原件仍用于文件名、体积和导出判断；预览用 PNG，避免 <img> 再次尝试解码 HEIC。
    const preview = await canvasToBlob(canvas, 'image/png')
    return { bitmap, preview }
  } catch (error) {
    bitmap.close()
    throw error
  } finally {
    canvas.width = canvas.height = 0
  }
}

export async function decodeToolboxImage(
  file: File,
): Promise<{ bitmap: ImageBitmap; preview: Blob }> {
  if (!isHeicFile(file)) return { bitmap: await createImageBitmap(file), preview: file }
  // 不同批次也串行，避免手机大图的解码像素和 PNG 预览同时占用多份内存。
  const run = heicGate.then(() => decodeHeic(file))
  heicGate = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
