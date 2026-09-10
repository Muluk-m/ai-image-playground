import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { PANEL_MARGIN, PANEL_WIDTH } from './agentStyles'
import { useAgentStore } from './store'

/** 面板在不在只在这里判一次，面板本体与画布控件都读它。 */
export function agentPanelPresent(): boolean {
  return isClientCapabilityEnabled('agent:chat')
}

/** 面板浮在画布左侧，画布左下角的控件据此让开它。 */
export function useAgentPanelInset(): number {
  const open = useAgentStore((state) => state.open)
  return open && agentPanelPresent() ? PANEL_MARGIN * 2 + PANEL_WIDTH : 0
}
