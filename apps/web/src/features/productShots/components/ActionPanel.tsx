import Pending from '../../../components/Pending'
import {
  ACTIVE_SEGMENT,
  CARD,
  FIELD,
  IDLE_SEGMENT,
  LABEL,
  NOTICE,
  PRIMARY_BUTTON,
  SEGMENT,
} from '../../../components/panelStyles'
import { REMIX_LEVELS } from '../../../lib/shotTypes'
import { ACTION_LABELS, type ProductShotAction, REMIX_LEVEL_LABELS } from '../lib/actions'
import { useProductShotsStore } from '../store'
import { PRODUCT_SHOT_STAGE_LABELS, VERSIONS_PER_IMAGE_CHOICES } from '../types'
import VersionBar from './VersionBar'

const NO_PRODUCT = '先在上方选产品素材'

const ACTIONS: Array<{ mode: ProductShotAction; needsProduct: boolean }> = [
  { mode: 'background', needsProduct: false },
  { mode: 'replace-product', needsProduct: true },
  { mode: 'remix', needsProduct: true },
]

export default function ActionPanel() {
  const preference = useProductShotsStore((s) => s.draft.preference)
  const versionsPerImage = useProductShotsStore((s) => s.draft.versionsPerImage)
  const runningMode = useProductShotsStore((s) => s.draft.mode)
  const level = useProductShotsStore((s) => s.draft.level)
  const hasProduct = useProductShotsStore((s) => s.draft.productAssets.length > 0)
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const swapStage = useProductShotsStore((s) => s.swapStage)
  const swapStartedAt = useProductShotsStore((s) => s.swapStartedAt)
  const swapNotice = useProductShotsStore((s) => s.swapNotice)
  const batchRunning = useProductShotsStore((s) => s.batch?.running === true)

  const { setPreference, setVersionsPerImage, setRemixLevel, runAction } =
    useProductShotsStore.getState()
  const busy = swapStage !== null || batchRunning

  return (
    <section data-product-shots-column="actions" className={`${CARD} flex flex-col gap-3`}>
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">动作</h2>

      <div className="flex flex-col gap-1.5">
        {ACTIONS.map((action) => {
          const blocked = action.needsProduct && !hasProduct
          const running = swapStage !== null && runningMode === action.mode
          return (
            <div key={action.mode}>
              <button
                type="button"
                data-product-shots-action={action.mode}
                onClick={() => void runAction(action.mode)}
                disabled={busy || blocked || !selectedImageId}
                className={PRIMARY_BUTTON}
              >
                {running ? (
                  <Pending label={PRODUCT_SHOT_STAGE_LABELS[swapStage]} startedAt={swapStartedAt} />
                ) : (
                  ACTION_LABELS[action.mode]
                )}
              </button>
              {action.mode === 'remix' && (
                <div className="mt-1 flex w-fit gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-white/[0.06]">
                  {REMIX_LEVELS.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      data-product-shots-level={choice}
                      onClick={() => setRemixLevel(choice)}
                      aria-pressed={level === choice}
                      className={`${SEGMENT} ${level === choice ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
                    >
                      {REMIX_LEVEL_LABELS[choice]}
                    </button>
                  ))}
                </div>
              )}
              {blocked && <p className={`mt-1 ${NOTICE}`}>{NO_PRODUCT}</p>}
            </div>
          )
        })}
      </div>

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

      {swapNotice && <p className={NOTICE}>{swapNotice}</p>}

      <VersionBar />
    </section>
  )
}
