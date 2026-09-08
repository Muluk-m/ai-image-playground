import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
import {
  CARD,
  FIELD,
  GHOST_BUTTON,
  LABEL,
  NOTICE,
  PANEL_SECTION,
  PANEL_TITLE,
} from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { REMIX_LEVELS } from '../../../lib/shotTypes'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { ACTION_LABELS, type ProductShotAction, REMIX_LEVEL_LABELS } from '../lib/actions'
import { sourceMatteNotice } from '../lib/matteBadge'
import { useProductShotsStore } from '../store'
import { PRODUCT_SHOT_STAGE_LABELS, VERSIONS_PER_IMAGE_CHOICES } from '../types'

const PICK_PRODUCT = '选产品素材'
const NO_PRODUCT = '产品素材：未选'
const NEEDS_PRODUCT = '换产品与借创意重做需要先选产品素材'

/** 三个动作挤在一排里，PRIMARY_BUTTON 的字号与内边距放不下最长的那个标签。 */
const ACTION_BUTTON =
  'rounded-lg bg-blue-500 px-1 py-1.5 text-xs font-medium leading-tight text-white transition hover:bg-blue-600 disabled:opacity-50'

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
  const productAssets = useProductShotsStore(useShallow((s) => s.draft.productAssets))
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const matteNotice = useProductShotsStore((s) =>
    sourceMatteNotice(
      s.draft.images.find((image) => image.imageId === s.selectedImageId)?.sourceMatte,
    ),
  )
  const swapStage = useProductShotsStore((s) => s.swapStage)
  const swapStartedAt = useProductShotsStore((s) => s.swapStartedAt)
  const swapNotice = useProductShotsStore((s) => s.swapNotice)
  const batchRunning = useProductShotsStore((s) => s.batch?.running === true)
  const assets = useLibraryStore(useShallow((s) => s.assets))

  const { setPreference, setVersionsPerImage, setRemixLevel, runAction, openProductPicker } =
    useProductShotsStore.getState()
  const busy = swapStage !== null || batchRunning
  const hasProduct = productAssets.length > 0

  return (
    <section data-product-shots-column="actions" className={`${CARD} flex flex-col gap-4`}>
      <div data-product-shots-settings className="flex flex-col gap-3">
        <h2 className={PANEL_TITLE}>设置</h2>

        <div>
          <label className={LABEL} htmlFor="product-shots-preference">
            偏好（可空）
          </label>
          <input
            id="product-shots-preference"
            value={preference}
            onChange={(e) => setPreference(e.target.value)}
            placeholder="例：北欧风，浅木色"
            className={`mt-1.5 ${FIELD}`}
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

        <div>
          <span className={LABEL}>与竞品的距离</span>
          <div className="mt-1.5 w-fit">
            <Segmented
              label="与竞品的距离"
              options={REMIX_LEVELS}
              labels={REMIX_LEVEL_LABELS}
              value={level}
              onChange={setRemixLevel}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {hasProduct ? (
            <ul className="flex flex-wrap gap-1">
              {productAssets.map((picked) => {
                const asset = assets.find((item) => item.id === picked.assetId)
                return (
                  <li
                    key={picked.assetId}
                    className="block h-8 w-8 overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]"
                  >
                    <AssetThumb imageId={asset?.imageId ?? ''} alt={asset?.name ?? ''} />
                  </li>
                )
              })}
            </ul>
          ) : (
            <span className={LABEL}>{NO_PRODUCT}</span>
          )}
          <button type="button" onClick={openProductPicker} className={`ml-auto ${GHOST_BUTTON}`}>
            {hasProduct ? '更换' : PICK_PRODUCT}
          </button>
        </div>
      </div>

      <div className={`${PANEL_SECTION} flex flex-col gap-2`}>
        <h2 className={PANEL_TITLE}>生成</h2>

        {matteNotice && (
          <p data-product-shots-matte-notice className={NOTICE}>
            {matteNotice}
          </p>
        )}

        <div className="grid grid-cols-3 gap-1.5">
          {ACTIONS.map((action) => {
            const running = swapStage !== null && runningMode === action.mode
            return (
              <button
                key={action.mode}
                type="button"
                data-product-shots-action={action.mode}
                onClick={() => void runAction(action.mode)}
                disabled={busy || !selectedImageId || (action.needsProduct && !hasProduct)}
                className={ACTION_BUTTON}
              >
                {running ? (
                  <Pending label={PRODUCT_SHOT_STAGE_LABELS[swapStage]} startedAt={swapStartedAt} />
                ) : (
                  ACTION_LABELS[action.mode]
                )}
              </button>
            )
          })}
        </div>

        {!hasProduct && (
          <p data-product-shots-action-reason className={NOTICE}>
            {NEEDS_PRODUCT}
          </p>
        )}
        {swapNotice && <p className={NOTICE}>{swapNotice}</p>}
      </div>
    </section>
  )
}
