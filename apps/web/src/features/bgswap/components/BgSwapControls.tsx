import Pending from '../../../components/Pending'
import { CARD, FIELD, LABEL, NOTICE, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useBgSwapStore } from '../store'
import { BG_SWAP_STAGE_LABELS, VERSIONS_PER_IMAGE_CHOICES } from '../types'
import BgSwapVersionBar from './BgSwapVersionBar'

export default function BgSwapControls() {
  const preference = useBgSwapStore((s) => s.draft.preference)
  const versionsPerImage = useBgSwapStore((s) => s.draft.versionsPerImage)
  const selectedImageId = useBgSwapStore((s) => s.selectedImageId)
  const swapStage = useBgSwapStore((s) => s.swapStage)
  const swapStartedAt = useBgSwapStore((s) => s.swapStartedAt)
  const swapNotice = useBgSwapStore((s) => s.swapNotice)
  const batchRunning = useBgSwapStore((s) => s.batch?.running === true)

  const { setPreference, setVersionsPerImage, swapBackground } = useBgSwapStore.getState()

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

      <button
        type="button"
        onClick={() => void swapBackground()}
        disabled={swapStage !== null || batchRunning || !selectedImageId}
        className={PRIMARY_BUTTON}
      >
        {swapStage ? (
          <Pending label={BG_SWAP_STAGE_LABELS[swapStage]} startedAt={swapStartedAt} />
        ) : (
          '换背景'
        )}
      </button>

      {swapNotice && <p className={NOTICE}>{swapNotice}</p>}

      <BgSwapVersionBar />
    </section>
  )
}
