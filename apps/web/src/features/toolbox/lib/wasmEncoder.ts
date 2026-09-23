import type { WasmEncodeRequest, WasmEncodeResponse } from './wasmEncoder.worker'

/** 分发 `WasmEncodeRequest` 时不带 id 的那部分。 */
type Job = WasmEncodeRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never

let worker: Worker | null = null
let nextId = 0
const pending = new Map<
  number,
  { resolve: (bytes: ArrayBuffer) => void; reject: (e: Error) => void }
>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./wasmEncoder.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WasmEncodeResponse>) => {
    const job = pending.get(event.data.id)
    if (!job) return
    pending.delete(event.data.id)
    if ('bytes' in event.data) job.resolve(event.data.bytes)
    else job.reject(new Error(event.data.error))
  }
  // Worker 整个挂了（wasm 下载失败、OOM）：在途的每一件都要有交代，下次再重建一个。
  worker.onerror = () => {
    for (const job of pending.values()) job.reject(new Error('wasm encoder crashed'))
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

function run(job: Job, transfer: Transferable[]): Promise<ArrayBuffer> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...job, id }, transfer)
  })
}

/** WebP / AVIF：canvas 编不出来时走 wasm。`quality` 是 0–1，和 canvas 口径一致。 */
export async function encodeWithWasm(
  canvas: HTMLCanvasElement,
  type: 'image/webp' | 'image/avif',
  quality: number,
): Promise<Blob> {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const bytes = await run(
    { kind: type === 'image/webp' ? 'webp' : 'avif', image, quality: Math.round(quality * 100) },
    [image.data.buffer],
  )
  return new Blob([bytes], { type })
}

/** PNG 无损再压：oxipng 只重排压缩方式，像素一个不动。 */
export async function optimisePng(png: Blob): Promise<Blob> {
  const buffer = await png.arrayBuffer()
  const bytes = await run({ kind: 'oxipng', png: buffer }, [buffer])
  return new Blob([bytes], { type: 'image/png' })
}
