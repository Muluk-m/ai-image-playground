import type { MatteBackend } from './backends'
import type { MatteWorkerRequest, MatteWorkerResponse } from './segmentWorker'
import type { ProductAlpha } from './types'

/**
 * 每一环起一个新 worker：onnxruntime 一旦 OrtRun 失败，同一 realm 里后续任何 session
 * 都会读回那条陈旧错误，回落链在同一个页面上下文里跑就全军覆没。
 */
export function runInWorker(
  backend: MatteBackend,
  dataUrl: string,
  signal: AbortSignal,
): Promise<ProductAlpha> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'module' })

    const settle = (finish: () => void) => {
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      finish()
    }
    function onAbort() {
      settle(() => reject(signal.reason))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<MatteWorkerResponse>) => {
      const data = event.data
      settle(() => (data.ok ? resolve(data.matte) : reject(new Error(data.message))))
    }
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || '抠图 worker 启动失败')))
    }

    worker.postMessage({ backend, dataUrl } satisfies MatteWorkerRequest)
  })
}
