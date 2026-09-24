import { isUserStorageScope } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { getRuntimeConfig } from '../../../lib/runtimeConfig'

/** 资产页上交给智能体的那几件事（用智能体创建、继续调试、用模板出图）要登录并开了同步。 */
export function libraryAgentReady(): boolean {
  return (
    getRuntimeConfig().bff.enabled &&
    isUserStorageScope() &&
    isClientCapabilityEnabled('accounts:sync')
  )
}
