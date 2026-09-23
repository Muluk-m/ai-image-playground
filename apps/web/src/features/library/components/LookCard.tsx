import type { KeyboardEvent } from 'react'
import Badge from '../../../components/Badge'
import { useTranslation } from '../../../i18n'
import type { LookItem } from '../lib/looks'
import LookImage from './LookImage'

export default function LookCard({
  look,
  needsRetune,
  canGenerate,
  onOpen,
  onGenerate,
  onTune,
}: {
  look: LookItem
  needsRetune: boolean
  canGenerate: boolean
  onOpen: (look: LookItem) => void
  onGenerate: (look: LookItem) => void
  onTune: (look: LookItem) => void
}) {
  const { t } = useTranslation('library')

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(look)
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:shadow-lg">
      {/* 外层不是 <button>：底部还有两个动作键，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(look)}
        onKeyDown={handleKeyDown}
        title={t('look.viewDetail')}
        className="relative aspect-[4/5] cursor-pointer overflow-hidden bg-muted focus:outline-none focus:ring-2 focus:ring-ring/60"
      >
        <LookImage source={look.cover} alt={look.name} />
        <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
          <Badge tone="overlay">{t(`look.purpose.${look.purpose}`)}</Badge>
          {look.origin === 'builtin' && <Badge tone="overlay">{t('look.builtinTag')}</Badge>}
        </div>
        {needsRetune && (
          <Badge tone="warning" className="pointer-events-none absolute right-1.5 top-1.5">
            {t('look.needsRetune')}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{look.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t('look.slots', { count: look.slotCount })}
          </span>
        </div>
        <span className="truncate text-[11px] text-muted-foreground">
          {look.model} · {look.size}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={needsRetune || !canGenerate}
            onClick={() => onGenerate(look)}
            className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('look.generate')}
          </button>
          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => onTune(look)}
            className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-foreground transition hover:bg-muted"
          >
            {look.origin === 'user' ? t('look.tune') : t('look.fork')}
          </button>
        </div>
      </div>
    </div>
  )
}
