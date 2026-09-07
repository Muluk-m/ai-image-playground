import Pending from '../../../components/Pending'
import { CARD, FIELD, LABEL, NOTICE, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { ACTION_LABELS, bgSwapMode } from '../lib/mode'
import { useProductShotsStore } from '../store'
import { PRODUCT_SHOT_STAGE_LABELS, VERSIONS_PER_IMAGE_CHOICES } from '../types'
import ProductBar from './ProductBar'
import VersionBar from './VersionBar'

export default function ActionPanel() {
  const preference = useProductShotsStore((s) => s.draft.preference)
  const versionsPerImage = useProductShotsStore((s) => s.draft.versionsPerImage)
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const swapStage = useProductShotsStore((s) => s.swapStage)
  const swapStartedAt = useProductShotsStore((s) => s.swapStartedAt)
  const swapNotice = useProductShotsStore((s) => s.swapNotice)
  const batchRunning = useProductShotsStore((s) => s.batch?.running === true)
  const mode = useProductShotsStore((s) => bgSwapMode(s.draft.productSource, s.draft.target))

  const { setPreference, setVersionsPerImage, swapBackground } = useProductShotsStore.getState()

  return (
    <section data-product-shots-column="controls" className={`${CARD} flex flex-col gap-3`}>
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">换背景</h2>

      <ProductBar />

      <div>
        <label className={LABEL} htmlFor="product-shots-preference">
          偏好（可空）
        </label>
        <textarea
          id="product-shots-preference"
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

      <button
        type="button"
        data-product-shots-swap
        onClick={() => void swapBackground()}
        disabled={swapStage !== null || batchRunning || !selectedImageId}
        className={PRIMARY_BUTTON}
      >
        {swapStage ? (
          <Pending label={PRODUCT_SHOT_STAGE_LABELS[swapStage]} startedAt={swapStartedAt} />
        ) : (
          ACTION_LABELS[mode]
        )}
      </button>

      {swapNotice && <p className={NOTICE}>{swapNotice}</p>}

      <VersionBar />
    </section>
  )
}
