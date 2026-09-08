export const MATTE_BACKEND = 'cloudflare-birefnet'

/** 与 BFF 路由体的 data URL maxLength 同源，两侧改一起改。 */
export const MATTE_MAX_IMAGE_BYTES = 4_000_000

export interface MatteResponse {
  /** PNG data URL，单通道语义：不透明 = 产品。 */
  readonly alpha: string
  readonly backend: typeof MATTE_BACKEND
  readonly cached: boolean
}

export function parseMatteResponse(value: unknown): MatteResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const { alpha, backend, cached } = value as Record<string, unknown>
  if (typeof alpha !== 'string' || !alpha.startsWith('data:image/png;base64,')) return null
  if (backend !== MATTE_BACKEND || typeof cached !== 'boolean') return null
  return { alpha, backend: MATTE_BACKEND, cached }
}
