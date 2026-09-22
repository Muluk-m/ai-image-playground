import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSkills } from '../features/agent/lib/useAgentSkills'
import { availableImageModels } from '../features/library/lib/activeLook'
import { type LookItem, lookNeedsRetune, mergeLookItems } from '../features/library/lib/looks'
import { useLibraryStore } from '../features/library/store'
import { useTranslation } from '../i18n'
import { useStore } from '../store'
import Badge from './Badge'
import { ChevronRightIcon, CloseIcon } from './icons'

const PILL =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs text-foreground transition hover:border-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'

const COLLAPSED_LIMIT = 5

/**
 * 输入框下方那排模板：自建在前（带实心点），预置在后；点了交给调用方（智能体输入框插
 * `/技能名`，生成模式挂胶囊）。「更多模板」去资产页。
 */
export default function LookChips({ onPick }: { onPick: (look: LookItem) => void }) {
  const { t } = useTranslation('library')
  const records = useLibraryStore(useShallow((s) => s.looks))
  const skills = useAgentSkills('image')
  const settings = useStore((s) => s.settings)
  const setAppMode = useStore((s) => s.setAppMode)
  const setTab = useLibraryStore((s) => s.setTab)
  const [expanded, setExpanded] = useState(false)

  const items = useMemo(() => mergeLookItems(records, skills), [records, skills])
  // settings 进依赖：切了 profile 或模型清单，「需重新调试」要跟着变。
  const models = useMemo(() => availableImageModels(), [settings])
  if (items.length === 0) return null
  const shown = expanded ? items : items.slice(0, COLLAPSED_LIMIT)

  return (
    <div className="flex items-center gap-2 overflow-x-auto pt-2" data-look-chips>
      {shown.map((look) => {
        const retune = lookNeedsRetune(look, models)
        return (
          <button
            key={look.skillName}
            type="button"
            disabled={retune}
            onClick={() => onPick(look)}
            title={look.description}
            className={PILL}
          >
            <span className="text-muted-foreground">/</span>
            {look.origin === 'user' && (
              <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            {look.name}
            {retune && <Badge tone="warning">{t('look.needsRetune')}</Badge>}
          </button>
        )
      })}
      {items.length > COLLAPSED_LIMIT && !expanded ? (
        <button type="button" onClick={() => setExpanded(true)} className={PILL}>
          {t('look.more')}
          <ChevronRightIcon className="h-3 w-3" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setTab('looks')
            setAppMode('library')
          }}
          className={`${PILL} text-muted-foreground`}
        >
          {t('look.more')}
          <ChevronRightIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

/** 生成模式输入框顶部那颗胶囊：像技能命令一样挂在正文前，摘掉就回到普通提交。 */
export function LookCapsule({
  look,
  issue,
  onRemove,
}: {
  look: LookItem
  issue: { reason: 'slot_mismatch'; expected: number } | null
  onRemove: () => void
}) {
  const { t } = useTranslation(['library', 'common'])
  return (
    <div
      data-look-capsule
      className={`mb-2 flex items-center gap-2 rounded-lg border px-2 py-1 text-xs ${
        issue ? 'border-warning/60 bg-warning/10' : 'border-primary/40 bg-primary/5'
      }`}
    >
      <span className="font-medium text-foreground">/{look.name}</span>
      <span className="text-muted-foreground">
        {look.model} · {look.size}
      </span>
      {issue && <Badge tone="warning">{t('look.slotMismatch', { count: issue.expected })}</Badge>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('common:action.close')}
        className="ml-auto rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
