import { useTranslation } from '../../../i18n'
import { type InspirationProviderFilter, useInspirationStore } from '../store'

// 后两项是产品名，不翻译；`all` 没有品牌名可用，走译文。
const TABS: Array<{ value: InspirationProviderFilter; label?: string }> = [
  { value: 'all' },
  { value: 'openai-compat', label: 'GPT Image' },
  { value: 'gemini', label: 'Nano Banana 2' },
]

export default function InspirationProviderTabs() {
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const setProvider = useInspirationStore((s) => s.setProvider)
  const { t } = useTranslation('inspiration')

  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 text-xs">
      {TABS.map((tab) => {
        const active = selectedProvider === tab.value
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => setProvider(tab.value)}
            className={`rounded-full px-3 py-1 transition ${
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label ?? t('filter.all')}
          </button>
        )
      })}
    </div>
  )
}
