/// <reference lib="webworker" />
import { heicTo } from 'heic-to/csp'

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const bitmap = await heicTo({ blob: event.data, type: 'bitmap' })
    ;(self as DedicatedWorkerGlobalScope).postMessage({ bitmap }, [bitmap])
  } catch {
    self.postMessage({ error: 'heic_decode_failed' })
  }
}
