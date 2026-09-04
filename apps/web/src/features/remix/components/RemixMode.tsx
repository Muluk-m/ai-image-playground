import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLibraryStore } from '../../library/store'
import { type RemixStep, useRemixStore } from '../store'
import RemixBriefStep from './RemixBriefStep'
import RemixGenerateStep from './RemixGenerateStep'
import RemixInputStep from './RemixInputStep'

const STEPS: Array<{ id: RemixStep; label: string }> = [
  { id: 1, label: '① 输入' },
  { id: 2, label: '② 简报与镜头' },
  { id: 3, label: '③ 生成与导出' },
]

export default function RemixMode() {
  const sets = useRemixStore(useShallow((s) => s.sets))
  const activeSetId = useRemixStore((s) => s.activeSetId)
  const step = useRemixStore((s) => s.step)
  const setStep = useRemixStore((s) => s.setStep)
  const selectSet = useRemixStore((s) => s.selectSet)
  const startNewSet = useRemixStore((s) => s.startNewSet)

  useEffect(() => {
    void useRemixStore.getState().loadSets()
    void useLibraryStore.getState().loadAssets()
  }, [])

  return (
    <main className="safe-area-x mx-auto max-w-6xl px-4 pb-24 pt-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">套</span>
        {sets.map((set) => (
          <button
            key={set.id}
            type="button"
            onClick={() => selectSet(set.id)}
            aria-pressed={activeSetId === set.id}
            className={`max-w-48 truncate rounded-lg px-3 py-1.5 text-sm transition ${
              activeSetId === set.id
                ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
            }`}
          >
            {set.name}
          </button>
        ))}
        <button
          type="button"
          onClick={startNewSet}
          className="rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.12] dark:text-gray-300 dark:hover:border-blue-500/50 dark:hover:text-blue-300"
        >
          新建套
        </button>
      </div>

      <nav className="mb-5 flex flex-wrap items-center gap-2">
        {STEPS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setStep(id)}
            aria-current={step === id ? 'step' : undefined}
            className={`rounded-full px-3.5 py-1.5 text-sm transition ${
              step === id
                ? 'bg-blue-500 font-medium text-white shadow-sm'
                : 'bg-gray-100 text-gray-500 hover:text-gray-700 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {step === 1 && <RemixInputStep />}
      {step === 2 && <RemixBriefStep />}
      {step === 3 && <RemixGenerateStep />}
    </main>
  )
}
