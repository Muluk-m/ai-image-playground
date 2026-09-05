import { useShallow } from 'zustand/react/shallow'
import { CARD, FIELD, LABEL, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useBgSwapStore } from '../store'
import { VERSIONS_PER_IMAGE_CHOICES } from '../types'

export default function BgSwapControls() {
  const preference = useBgSwapStore((s) => s.draft.preference)
  const versionsPerImage = useBgSwapStore((s) => s.draft.versionsPerImage)
  const versions = useBgSwapStore(
    useShallow(
      (s) => s.draft.images.find((image) => image.imageId === s.selectedImageId)?.versions ?? [],
    ),
  )

  const { setPreference, setVersionsPerImage } = useBgSwapStore.getState()

  return (
    <section data-bgswap-column="controls" className={`${CARD} flex flex-col gap-3`}>
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">换背景</h2>

      <div>
        <label className={LABEL} htmlFor="bgswap-preference">
          偏好（可空）
        </label>
        <textarea
          id="bgswap-preference"
          value={preference}
          rows={2}
          onChange={(e) => setPreference(e.target.value)}
          placeholder="例：北欧风，浅木色"
          className={`mt-1.5 ${FIELD} resize-y`}
        />
      </div>

      <div>
        <span className={LABEL}>每张几版</span>
        <div className="mt-1.5 flex gap-1.5">
          {VERSIONS_PER_IMAGE_CHOICES.map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => setVersionsPerImage(count)}
              aria-pressed={versionsPerImage === count}
              className={`rounded-lg px-2.5 py-1 text-sm transition ${
                versionsPerImage === count
                  ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
              }`}
            >
              {count}
            </button>
          ))}
        </div>
      </div>

      {/* 出图在 #109 落地，本票只占位。 */}
      <button type="button" disabled className={PRIMARY_BUTTON}>
        换背景
      </button>

      <div>
        <span className={LABEL}>版本</span>
        <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
          {versions.length === 0 ? '暂无版本' : `${versions.length} 版`}
        </p>
      </div>
    </section>
  )
}
