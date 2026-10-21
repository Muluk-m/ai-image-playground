/// <reference lib="webworker" />
/**
 * 浏览器里的免费分割：SlimSAM-77（量化后约 14MB），WASM 后端。只认点提示，框由调用方换成点。
 * 模型与运行时都按需下载、浏览器缓存；首次约十几秒，之后编码 2–5 秒、解码不到 1 秒。
 */
import type { SegmentRequest, SegmentResponse } from './segmentClient'

type Transformers = typeof import('@huggingface/transformers')
type Loaded = {
  readonly lib: Transformers
  readonly model: Awaited<ReturnType<Transformers['SamModel']['from_pretrained']>>
  readonly processor: Awaited<ReturnType<Transformers['AutoProcessor']['from_pretrained']>>
}

let loading: Promise<Loaded> | null = null

function load(request: SegmentRequest): Promise<Loaded> {
  loading ??= (async () => {
    const lib = await import('@huggingface/transformers')
    lib.env.allowLocalModels = false
    if (request.modelHost) lib.env.remoteHost = request.modelHost
    const wasm = lib.env.backends.onnx?.wasm
    if (request.wasmPath && wasm) wasm.wasmPaths = request.wasmPath
    const [model, processor] = await Promise.all([
      lib.SamModel.from_pretrained(request.model, { dtype: 'q8', device: 'wasm' }),
      lib.AutoProcessor.from_pretrained(request.model),
    ])
    return { lib, model, processor }
  })()
  loading.catch(() => {
    loading = null
  })
  return loading
}

async function segment(request: SegmentRequest): Promise<SegmentResponse> {
  const { lib, model, processor } = await load(request)
  const image = new lib.RawImage(request.pixels, request.width, request.height, 4).rgb()
  const inputs = await processor(image, {
    input_points: [request.points],
    input_labels: [request.labels],
  })
  const outputs = await model(inputs)
  const sam = processor as unknown as {
    post_process_masks(
      masks: unknown,
      originalSizes: unknown,
      reshapedSizes: unknown,
    ): Promise<{ dims: number[]; data: ArrayLike<number | boolean> }[]>
  }
  const masks = await sam.post_process_masks(
    outputs.pred_masks,
    inputs.original_sizes,
    inputs.reshaped_input_sizes,
  )
  const tensor = masks[0]!
  const [, count, height, width] = tensor.dims
  const source = tensor.data
  const candidates: Uint8Array[] = []
  for (let index = 0; index < (count ?? 0); index++) {
    const mask = new Uint8Array(width! * height!)
    const offset = index * mask.length
    for (let pixel = 0; pixel < mask.length; pixel++) mask[pixel] = source[offset + pixel] ? 1 : 0
    candidates.push(mask)
  }
  return {
    id: request.id,
    width: width!,
    height: height!,
    masks: candidates,
    scores: Array.from(outputs.iou_scores.data as ArrayLike<number>),
  }
}

self.onmessage = (event: MessageEvent<SegmentRequest>) => {
  const request = event.data
  segment(request).then(
    (response) =>
      self.postMessage(
        response,
        'masks' in response ? response.masks.map((mask: Uint8Array) => mask.buffer) : [],
      ),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SegmentResponse),
  )
}
