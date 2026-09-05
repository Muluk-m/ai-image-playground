import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers'
import type { ProductAlpha } from './types'

/**
 * BiRefNet_lite（MIT）：通用显著物体分割，不挑品类。只提供 fp32 / fp16 两种权重，
 * 这里取 fp16 + WebGPU（约 114 MB，浏览器 Cache 存一次）。
 */
const MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX'

type Segmenter = Awaited<ReturnType<typeof loadSegmenter>>

let segmenter: Promise<Segmenter> | null = null

async function loadSegmenter() {
  const [model, processor] = await Promise.all([
    AutoModel.from_pretrained(MODEL_ID, { dtype: 'fp16', device: 'webgpu' }),
    AutoProcessor.from_pretrained(MODEL_ID),
  ])
  return { model, processor }
}

export async function runProductSegmentation(dataUrl: string): Promise<ProductAlpha> {
  segmenter ??= loadSegmenter()
  const { model, processor } = await segmenter

  const image = await RawImage.fromURL(dataUrl)
  const { pixel_values } = await processor(image)
  const { output_image } = await model({ input_image: pixel_values })
  const mask = await RawImage.fromTensor(output_image[0].sigmoid().mul(255).to('uint8')).resize(
    image.width,
    image.height,
  )

  return {
    alpha: new Uint8ClampedArray(mask.data),
    width: mask.width,
    height: mask.height,
  }
}
