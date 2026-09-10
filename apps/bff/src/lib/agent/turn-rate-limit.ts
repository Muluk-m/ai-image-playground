import { config } from '../../config'
import { createRateLimiter, type RateLimiter } from '../rate-limit'

const perDeviceMinute = config.operator.quotas['agent:turns-per-device-minute']
const perAddressHour = config.operator.quotas['agent:turns-per-ip-hour']

const deviceLimiter = createRateLimiter({
  maxFailures: perDeviceMinute,
  windowMs: 60_000,
  lockMs: 60_000,
  maxEntries: 4096,
})

const addressLimiter = createRateLimiter({
  maxFailures: perAddressHour,
  windowMs: 60 * 60_000,
  lockMs: 60 * 60_000,
  maxEntries: 4096,
})

function over(limiter: RateLimiter, threshold: number, key: string): boolean {
  if (threshold <= 0) return false
  return limiter.isLocked(key) || limiter.recordFailure(key)
}

/**
 * 两维都要：设备 id 是浏览器自己生成的，脚本换一个就绕开设备维；而一个出口 IP 后面
 * 可能坐着一屋子真人，所以 IP 维只能宽到防脚本。
 */
export function agentTurnRateLimited(deviceId: string, address: string): boolean {
  return (
    over(deviceLimiter, perDeviceMinute, deviceId) || over(addressLimiter, perAddressHour, address)
  )
}
