import type { QueueProvider } from '@image-playground/shared'

/** DB 里存的 provider 是 TEXT；窄化到 QueueProvider union 或返回 null。 */
export function asQueueProvider(provider: string): QueueProvider | null {
  if (provider === 'openai-compat' || provider === 'gemini') return provider
  return null
}

/** fetch 被 AbortController.abort() 触发时跨 runtime 一致的判断。 */
export function isAbortError(err: unknown): boolean {
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  )
    return true
  return err instanceof Error && err.name === 'AbortError'
}
