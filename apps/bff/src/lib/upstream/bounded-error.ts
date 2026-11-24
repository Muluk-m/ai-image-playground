import { log } from '../logger'
import { extractErrorMessage, stringifyUpstreamPayload } from './errors'
import type { UpstreamCallResult } from './shared'
import type { UpstreamResponse } from './types'

/**
 * 非 2xx 诊断最多只存前 2000 字符（见 errors.ts 的 UPSTREAM_ERROR_BODY_MAX_CHARS）。
 * 流式按 64 KiB 封顶读取并立即取消剩余响应体，避免异常网关返回数十 MB 页面或长流占满内存。
 */
export const UPSTREAM_ERROR_BODY_MAX_BYTES = 64 * 1024

export async function readBoundedErrorText(
  res: UpstreamResponse,
  maxBytes = UPSTREAM_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  if (!res.body) {
    const raw = await res.text()
    return raw.slice(0, maxBytes)
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      const remaining = maxBytes - total
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function parseUpstreamResponse(res: UpstreamResponse): Promise<UpstreamCallResult> {
  if (!res.ok) {
    const text = await readBoundedErrorText(res)
    let payload: unknown = text
    try {
      payload = JSON.parse(text)
    } catch {
      /* keep raw text */
    }
    const message = extractErrorMessage(payload, res.status)
    // 上游 envelope 完整落 log（截断）：extractErrorMessage 可能把诊断信息提取
    // 成兜底字符串（如 "Upstream request failed"），原始 body 里的 error.code /
    // 上游真错因（"upstream did not return image output" 等）会丢，这里补回。
    log.warn(
      {
        event: 'upstream.non_2xx',
        upstreamStatus: res.status,
        message,
        payloadPreview: stringifyUpstreamPayload(payload),
      },
      'upstream returned non-2xx',
    )
    const err = new Error(message) as Error & { upstreamStatus: number; upstreamPayload: unknown }
    err.upstreamStatus = res.status
    err.upstreamPayload = payload
    throw err
  }
  const text = await res.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {
    /* keep raw text */
  }
  return { payload }
}
