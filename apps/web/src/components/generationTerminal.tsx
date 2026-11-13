import type { CSSProperties, ReactNode } from 'react'
import type { GenerationPhase } from '../lib/generationActivity'
import { Icon, type IconName } from './ui/icon'

export type GenerationTerminalPhase = 'cancelled' | 'failed' | 'stale'

const FACE: Record<GenerationTerminalPhase, { icon: IconName; muted: boolean }> = {
  cancelled: { icon: 'close', muted: true },
  failed: { icon: 'error', muted: false },
  stale: { icon: 'error', muted: false },
}

const DETAIL_CLAMP: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 4,
}

/** 取消、失败、过期都是终态。进行中的阶段返回 null。 */
export function generationTerminalPhase(phase: GenerationPhase): GenerationTerminalPhase | null {
  if (phase === 'cancelled' || phase === 'failed' || phase === 'stale') return phase
  return null
}

/**
 * 工作台卡片和详情共用的终态画面。
 * 过期不能再留一块空白，取消也不能画成红色失败。
 */
export function GenerationTerminalFace({
  phase,
  label,
  layout,
  children,
}: {
  phase: GenerationTerminalPhase
  label: string
  layout: 'card' | 'detail'
  children?: ReactNode
}) {
  const face = FACE[phase]
  const tone = face.muted ? 'text-muted-foreground' : 'text-destructive'
  if (layout === 'card') {
    return (
      <div className="flex flex-col items-center gap-1 px-2">
        <Icon name={face.icon} size="lg" className={tone} />
        <span className={`text-center text-xs leading-tight ${tone}`}>{label}</span>
      </div>
    )
  }
  return (
    <div className="w-full max-w-md px-4 text-center">
      <Icon name={face.icon} size="lg" className={`mx-auto mb-2 ${tone}`} />
      {phase === 'cancelled' ? (
        <p className={`text-sm leading-6 ${tone}`}>{label}</p>
      ) : (
        <p
          className={`overflow-hidden whitespace-pre-line break-words text-sm leading-6 ${tone}`}
          style={DETAIL_CLAMP}
        >
          {label}
        </p>
      )}
      {children}
    </div>
  )
}
