import type { AgentThinkingDepth } from '@image-playground/shared'
import { Icon, type IconName } from '../../../components/ui/icon'

const MARK: Record<AgentThinkingDepth, IconName> = {
  fast: 'gaugeLow',
  medium: 'gaugeMid',
  deep: 'gaugeHigh',
}

/** 思考深度三档：指针向左是快速，向上是中等，向右是深度。 */
export function ThinkingDepthMark({ depth }: { depth: AgentThinkingDepth }) {
  return (
    <span data-thinking-depth={depth} className="inline-flex shrink-0">
      <Icon name={MARK[depth]} />
    </span>
  )
}
