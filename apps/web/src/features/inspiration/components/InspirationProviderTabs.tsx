import { useInspirationStore, type InspirationProviderFilter } from '../store'

const TABS: Array<{ value: InspirationProviderFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'openai-compat', label: 'GPT Image 2' },
  { value: 'gemini', label: 'Nano Banana 2' },
]

export default function InspirationProviderTabs() {
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const setProvider = useInspirationStore((s) => s.setProvider)

  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-gray-200 bg-gray-50 p-0.5 text-xs dark:border-white/[0.08] dark:bg-white/[0.04]">
      {TABS.map((tab) => {
        const active = selectedProvider === tab.value
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => setProvider(tab.value)}
            className={`rounded-full px-3 py-1 transition ${
              active
                ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-50'
                : 'text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100'
            }`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
