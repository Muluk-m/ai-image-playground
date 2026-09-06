/// <reference lib="webworker" />
import { AutoModel, Tensor } from '@huggingface/transformers'
import type { MatteBackend } from './backends'
import { rgbaToNchw, scoresToAlpha } from './matteTensor'
import type { ProductAlpha } from './types'

export interface MatteWorkerRequest {
  backend: MatteBackend
  dataUrl: string
}

export type MatteWorkerResponse = { ok: true; matte: ProductAlpha } | { ok: false; message: string }

async function toSquareInput(dataUrl: string, size: number) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('OffscreenCanvas 2d 上下文不可用')
  context.drawImage(bitmap, 0, 0, size, size)
  const rgba = context.getImageData(0, 0, size, size).data
  return { input: rgbaToNchw(rgba, size), width: bitmap.width, height: bitmap.height }
}

/** 模型出的是方形小图，蒙版要和原图同尺寸才能提交，所以在 worker 里就缩回去。 */
function resizeAlpha(
  alpha: Uint8ClampedArray,
  size: number,
  width: number,
  height: number,
): ProductAlpha {
  const source = new OffscreenCanvas(size, size)
  const sourceContext = source.getContext('2d')
  const target = new OffscreenCanvas(width, height)
  const targetContext = target.getContext('2d')
  if (!sourceContext || !targetContext) throw new Error('OffscreenCanvas 2d 上下文不可用')

  const image = sourceContext.createImageData(size, size)
  for (let i = 0; i < alpha.length; i++) {
    image.data[i * 4] = alpha[i]
    image.data[i * 4 + 1] = alpha[i]
    image.data[i * 4 + 2] = alpha[i]
    image.data[i * 4 + 3] = 255
  }
  sourceContext.putImageData(image, 0, 0)
  targetContext.drawImage(source, 0, 0, width, height)

  const scaled = targetContext.getImageData(0, 0, width, height).data
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0; i < out.length; i++) out[i] = scaled[i * 4]
  return { alpha: out, width, height }
}

async function segment({ backend, dataUrl }: MatteWorkerRequest): Promise<ProductAlpha> {
  const model = await AutoModel.from_pretrained(backend.modelId, {
    dtype: backend.dtype,
    device: backend.device,
  })
  const size = backend.inputSize
  const { input, width, height } = await toSquareInput(dataUrl, size)
  const output = await model({
    [backend.inputName]: new Tensor('float32', input, [1, 3, size, size]),
  })
  // U²-Net 出 7 个输出，第一个才是融合后的那张；按名字取会挑到某一层的中间监督图。
  const first = output[Object.keys(output)[0]]
  const scores = Array.isArray(first) ? first[0] : first
  return resizeAlpha(scoresToAlpha(scores.data, backend.activation), size, width, height)
}

self.onmessage = async (event: MessageEvent<MatteWorkerRequest>) => {
  try {
    const matte = await segment(event.data)
    const response: MatteWorkerResponse = { ok: true, matte }
    self.postMessage(response, [matte.alpha.buffer])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({ ok: false, message } satisfies MatteWorkerResponse)
  }
}
