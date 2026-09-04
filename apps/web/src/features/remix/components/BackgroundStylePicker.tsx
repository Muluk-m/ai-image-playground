import { BACKGROUND_PRESETS } from '@image-playground/shared'
import { useShallow } from 'zustand/react/shallow'
import { CARD, FIELD, LABEL, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useRemixStore } from '../store'

export default function BackgroundStylePicker() {
  const selected = useRemixStore(useShallow((s) => s.backgroundStyleIds))
  const custom = useRemixStore((s) => s.customBackground)
  const imageCount = useRemixStore((s) => s.draft.sourceImageIds.length)
  const toggleBackgroundStyle = useRemixStore((s) => s.toggleBackgroundStyle)
  const setCustomBackground = useRemixStore((s) => s.setCustomBackground)
  const expandOwnShots = useRemixStore((s) => s.expandOwnShots)

  const styleCount = selected.length + (custom.trim() ? 1 : 0)

  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void expandOwnShots()} className={PRIMARY_BUTTON}>
          展开镜头
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {imageCount} 图 × {styleCount} 风格 · {imageCount * styleCount} 镜
        </span>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {BACKGROUND_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              onClick={() => toggleBackgroundStyle(preset.id)}
              aria-pressed={selected.includes(preset.id)}
              className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                selected.includes(preset.id)
                  ? 'border-blue-400 bg-blue-500/5 dark:border-blue-500/50'
                  : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.08]'
              }`}
            >
              <span className="block text-sm font-medium text-gray-800 dark:text-gray-100">
                {preset.label}
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {preset.wall}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div>
        <label className={LABEL} htmlFor="remix-custom-background">
          自写风格
        </label>
        <textarea
          id="remix-custom-background"
          value={custom}
          rows={2}
          onChange={(event) => setCustomBackground(event.target.value)}
          placeholder="例：日式汤屋，杉木墙面，深色石地"
          className={`mt-1.5 ${FIELD} resize-y`}
        />
      </div>
    </div>
  )
}
