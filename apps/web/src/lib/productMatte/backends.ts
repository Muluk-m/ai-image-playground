export type MatteBackendId = 'webgpu-birefnet' | 'webgpu-u2netp' | 'wasm-u2netp'

export type MatteDevice = 'webgpu' | 'wasm'

/** 模型输出怎么变成 alpha：BiRefNet 出 logits 要过 sigmoid，U²-Netp 出的分数按 rembg 的做法拉满量程。 */
export type MatteActivation = 'sigmoid' | 'minmax'

export interface MatteBackend {
  id: MatteBackendId
  device: MatteDevice
  modelId: string
  dtype: 'fp16' | 'fp32'
  inputName: string
  inputSize: number
  activation: MatteActivation
  /** 这一环自己的上限，含首次下权重；超了就走下一环。 */
  timeoutMs: number
  /** WebGPU 环要求的 `maxStorageBuffersPerShaderStage`，达不到就别下权重了，跑起来必炸。 */
  minStorageBuffers?: number
}

/**
 * 回落链，从质量最好排到最兜底。
 *
 * BiRefNet_lite 只有 fp16 / fp32 两份权重，fp32 是 224 MB，浏览器端不可接受；
 * 上游也没有量化版，所以第二环换的是模型不是精度。
 */
export const MATTE_BACKENDS: readonly MatteBackend[] = [
  {
    id: 'webgpu-birefnet',
    device: 'webgpu',
    modelId: 'onnx-community/BiRefNet_lite-ONNX',
    dtype: 'fp16',
    inputName: 'input_image',
    inputSize: 1024,
    activation: 'sigmoid',
    timeoutMs: 90_000,
    minStorageBuffers: 11,
  },
  {
    id: 'webgpu-u2netp',
    device: 'webgpu',
    modelId: 'BritishWerewolf/U-2-Netp',
    dtype: 'fp32',
    inputName: 'input.1',
    inputSize: 320,
    activation: 'minmax',
    timeoutMs: 30_000,
  },
  {
    id: 'wasm-u2netp',
    device: 'wasm',
    modelId: 'BritishWerewolf/U-2-Netp',
    dtype: 'fp32',
    inputName: 'input.1',
    inputSize: 320,
    activation: 'minmax',
    timeoutMs: 60_000,
  },
]

export const MATTE_BACKEND_LABELS: Record<MatteBackendId, string> = {
  'webgpu-birefnet': 'BiRefNet · GPU',
  'webgpu-u2netp': 'U²-Netp · GPU',
  'wasm-u2netp': 'U²-Netp · CPU',
}

type MatteAdapter = { limits?: { maxStorageBuffersPerShaderStage?: number } }
type MatteGpu = { requestAdapter(): Promise<MatteAdapter | null> }

/** 没有 WebGPU 或问不出适配器时返回 0，GPU 环一律出局。 */
async function storageBuffersPerShaderStage(): Promise<number> {
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as { gpu?: MatteGpu }).gpu
  if (!gpu) return 0
  try {
    const adapter = await gpu.requestAdapter()
    return adapter?.limits?.maxStorageBuffersPerShaderStage ?? 0
  } catch {
    return 0
  }
}

export async function eligibleBackends(
  backends: readonly MatteBackend[] = MATTE_BACKENDS,
): Promise<readonly MatteBackend[]> {
  if (!backends.some((backend) => backend.device === 'webgpu')) return backends
  const storageBuffers = await storageBuffersPerShaderStage()
  return backends.filter(
    (backend) =>
      backend.device !== 'webgpu' ||
      (storageBuffers > 0 && storageBuffers >= (backend.minStorageBuffers ?? 1)),
  )
}
