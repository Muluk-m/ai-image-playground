import type { AgentMaskPromptPoint, AgentNormalizedBox } from '@image-playground/shared'
import { pickSegmentMask, promptPoints, resizeMask, type TargetMask } from './maskProposal'

/** 分割输入的长边：SlimSAM 本来就把图缩到 1024 再编码，送更大的只是白传。 */
const SEGMENT_EDGE = 1024
/** 首次要下载模型与运行时，给足时间；超时就退回粗略范围。 */
const SEGMENT_TIMEOUT_MS = 60_000
const SEGMENT_MODEL = 'Xenova/slimsam-77-uniform'

export interface SegmentRequest {
  readonly id: number
  readonly model: string
  readonly modelHost?: string
  readonly wasmPath?: string
  readonly pixels: Uint8ClampedArray
  readonly width: number
  readonly height: number
  readonly points: [number, number][]
  readonly labels: number[]
}

export type SegmentResponse =
  | {
      readonly id: number
      readonly width: number
      readonly height: number
      readonly masks: Uint8Array[]
      readonly scores: number[]
      readonly error?: undefined
    }
  | { readonly id: number; readonly error: string }

/** 分割的提供方。现在只有浏览器里的 SlimSAM；服务端（SAM 3）的结果随提议一起下发。 */
export interface BrowserSegmenter {
  segment(input: {
    image: HTMLImageElement
    box: AgentNormalizedBox
    points?: readonly AgentMaskPromptPoint[]
    signal?: AbortSignal
  }): Promise<TargetMask | null>
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (response: SegmentResponse) => void>()

function segmentWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<SegmentResponse>) => {
    pending.get(event.data.id)?.(event.data)
    pending.delete(event.data.id)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    for (const [id, resolve] of pending) resolve({ id, error: 'worker_failed' })
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

function scaledPixels(image: HTMLImageElement): {
  pixels: Uint8ClampedArray
  width: number
  height: number
} {
  const scale = Math.min(1, SEGMENT_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('canvas_unavailable')
  context.drawImage(image, 0, 0, width, height)
  return { pixels: context.getImageData(0, 0, width, height).data, width, height }
}

export const browserSegmenter: BrowserSegmenter = {
  async segment({ image, box, points, signal }) {
    if (typeof Worker === 'undefined' || !image.naturalWidth) return null
    const { pixels, width, height } = scaledPixels(image)
    const prompt = promptPoints(box, points, width, height)
    const id = nextId++
    const env = import.meta.env as Record<string, string | undefined>
    const request: SegmentRequest = {
      id,
      model: env.VITE_SEGMENT_MODEL ?? SEGMENT_MODEL,
      ...(env.VITE_SEGMENT_MODEL_HOST ? { modelHost: env.VITE_SEGMENT_MODEL_HOST } : {}),
      ...(env.VITE_SEGMENT_WASM_PATH ? { wasmPath: env.VITE_SEGMENT_WASM_PATH } : {}),
      pixels,
      width,
      height,
      points: prompt.points,
      labels: prompt.labels,
    }
    const response = await new Promise<SegmentResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ id, error: 'timeout' })
      }, SEGMENT_TIMEOUT_MS)
      const finish = (value: SegmentResponse) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        pending.delete(id)
        finish({ id, error: 'aborted' })
      }
      signal?.addEventListener('abort', abort, { once: true })
      pending.set(id, finish)
      segmentWorker().postMessage(request, [pixels.buffer])
    })
    if (response.error !== undefined) return null
    const picked = pickSegmentMask(
      response.masks.map((data) => ({ data, width: response.width, height: response.height })),
      response.scores,
      box,
    )
    return picked ? resizeMask(picked, image.naturalWidth, image.naturalHeight) : null
  },
}
