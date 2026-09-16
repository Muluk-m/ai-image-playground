import { type InspirationProviderFilter, useInspirationStore } from '../store'

const TABS: Array<{ value: InspirationProviderFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'openai-compat', label: 'GPT Image' },
  { value: 'gemini', label: 'Nano Banana 2' },
]

export default function InspirationProviderTabs() {
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const setProvider = useInspirationStore((s) => s.setProvider)

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
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
