import type { CapabilityValues } from '@image-playground/shared'

const CREDENTIALED = ['accounts:login', 'billing:credits'] as const

/**
 * `*` 让浏览器带着 cookie 从任意 origin 调 BFF。登录或积分打开时这是跨站请求面，启动和热更新都拒绝。
 * 两项都关着时仍允许显式的 `*`，给本地匿名开发留口。
 */
export function assertCredentialedCors(
  corsOrigins: string,
  capabilities: Pick<CapabilityValues, 'accounts:login' | 'billing:credits'>,
): void {
  if (corsOrigins !== '*') return
  const enabled = CREDENTIALED.filter((key) => capabilities[key])
  if (enabled.length === 0) return
  throw new Error(
    `CORS_ALLOWED_ORIGINS=* is refused while ${enabled.join(' and ')} is enabled. Set an explicit origin list.`,
  )
}
