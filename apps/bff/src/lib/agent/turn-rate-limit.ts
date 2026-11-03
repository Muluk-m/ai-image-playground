import type { QuotaValues } from '@image-playground/shared'
import { config } from '../../config'
import { createWindowLimiter } from '../rate-limit'
export type AgentTurnRateLimiter = (deviceId: string, address: string) => boolean

/** 两维都要：设备 id 由浏览器自己生成，换一个就绕开设备维。 */
export function createAgentTurnRateLimiter(quotas?: QuotaValues): AgentTurnRateLimiter {
  const devices = createWindowLimiter(60_000, 4096)
  const addresses = createWindowLimiter(60 * 60_000, 4096)
  return (deviceId, address) => {
    // Explicit quotas are retained for tests and isolated callers. The shared limiter reads the
    // current operator snapshot on every decision so a DB override takes effect without restart.
    const current = quotas ?? config.operator.quotas
    return (
      devices.over(deviceId, current['agent:turns-per-device-minute']) ||
      addresses.over(address, current['agent:turns-per-ip-hour'])
    )
  }
}

export const agentTurnRateLimited = createAgentTurnRateLimiter()
