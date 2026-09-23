/// <reference lib="webworker" />
/**
 * wasm 编码器跑在这个 Worker 里：AVIF 一张 2000px 要编好几秒，放主线程会把整页卡住。
 * 各编码器按需 import——只选过 WebP 的人不下载 3.4 MB 的 AVIF 编码器。
 * 没有跨源隔离时 jSquash 自己退到单线程变体（它用 `wasm-feature-detect` 判线程）。
 */

export type WasmEncodeRequest =
  | { id: number; kind: 'webp' | 'avif'; image: ImageData; quality: number }
  | { id: number; kind: 'oxipng'; png: ArrayBuffer }

export type WasmEncodeResponse = { id: number; bytes: ArrayBuffer } | { id: number; error: string }

async function encode(request: WasmEncodeRequest): Promise<ArrayBuffer> {
  if (request.kind === 'oxipng') {
    const { default: optimise } = await import('@jsquash/oxipng/optimise')
    return optimise(request.png, { level: 2 })
  }
  if (request.kind === 'webp') {
    const { default: encodeWebp } = await import('@jsquash/webp/encode')
    return encodeWebp(request.image, { quality: request.quality })
  }
  const { default: encodeAvif } = await import('@jsquash/avif/encode')
  return encodeAvif(request.image, { quality: request.quality })
}

self.onmessage = async (event: MessageEvent<WasmEncodeRequest>) => {
  const { id } = event.data
  try {
    const bytes = await encode(event.data)
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, bytes } satisfies WasmEncodeResponse, [
      bytes,
    ])
  } catch (error) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WasmEncodeResponse)
  }
}
