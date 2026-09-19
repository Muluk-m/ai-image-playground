import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'

/** 面板在不在只在这里判一次，面板本体与画布控件都读它。 */
export function agentPanelPresent(): boolean {
  return isClientCapabilityEnabled('agent:chat')
}
