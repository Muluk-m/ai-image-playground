import type { ImagePreparationLimits, PreparedImage } from './policy'
import { prepareImage } from './prepare'

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ data: ArrayBuffer; limits: ImagePreparationLimits }>) => void
  postMessage: (
    result: { image?: PreparedImage; errorCode?: string },
    transfer?: Transferable[],
  ) => void
}
worker.onmessage = async ({ data: { data, limits } }) => {
  try {
    const image = await prepareImage(data, limits)
    worker.postMessage({ image }, [image.data])
  } catch (error) {
    worker.postMessage({
      errorCode: error instanceof Error ? error.message : 'attachment_compression_failed',
    })
  }
}
