import type { AgentThinkingDepth } from '@image-playground/shared'
import { cn } from '../../../lib/utils'

const LEVEL: Record<AgentThinkingDepth, number> = { fast: 1, medium: 2, deep: 3 }
const BAR = ['h-1.5', 'h-2.5', 'h-3.5'] as const

/** 思考深度的三档刻度：一格快、两格中、三格深。收起后的设置按钮放不下「思考：深度」。 */
export function ThinkingDepthMark({ depth }: { depth: AgentThinkingDepth }) {
  const level = LEVEL[depth]
  return (
    <span
      data-thinking-depth={depth}
      aria-hidden="true"
      className="flex h-3.5 w-3.5 shrink-0 items-end justify-center gap-0.5"
    >
      {BAR.map((height, index) => (
        <span
          key={height}
          className={cn(
            'w-0.5 rounded-full bg-current',
            height,
            index < level ? 'opacity-100' : 'opacity-25',
          )}
        />
      ))}
    </span>
  )
}
