import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
import { CARD, GHOST_BUTTON, OUTLINE_BUTTON, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useTranslation } from '../../../i18n'
import { batchDoneCount, pendingBatchImageIds, skippedDiagramImageIds } from '../lib/batch'
import { sourceMatteBadge } from '../lib/matteBadge'
import { useProductShotsStore } from '../store'
import {
  type ProductShotBatchItemState,
  productShotBatchStateLabels,
  productShotStageLabels,
} from '../types'
import BadgeTag from './BadgeTag'

const STATE_STYLES: Record<ProductShotBatchItemState, string> = {
  pending: 'text-gray-500 dark:text-gray-400',
  running: 'text-blue-700 dark:text-blue-300',
  done: 'text-emerald-700 dark:text-emerald-300',
  error: 'text-red-600 dark:text-red-300',
}

export default function BatchBar() {
  const { t } = useTranslation('productShots')
  const images = useProductShotsStore(useShallow((s) => s.draft.images))
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const swapStage = useProductShotsStore((s) => s.swapStage)
  const batch = useProductShotsStore((s) => s.batch)
  const matting = useProductShotsStore(useShallow((s) => s.mattingImageIds))

  const { runBatch, runBatchImage, stopBatch } = useProductShotsStore.getState()
  const remaining = pendingBatchImageIds(images, selectedImageId)
  const skipped = skippedDiagramImageIds(images, selectedImageId)
  const orderOf = (imageId: string) => images.findIndex((image) => image.imageId === imageId) + 1
  const matteOf = (imageId: string) =>
    images.find((image) => image.imageId === imageId)?.sourceMatte
  const running = batch?.running === true
  const current = batch?.items.find((item) => item.state === 'running')

  return (
    <section data-product-shots-batch className={`${CARD} mt-4 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-700 dark:text-gray-200">
          {running
            ? current
              ? t('batch.progressCurrent', {
                  done: batchDoneCount(batch.items),
                  total: batch.items.length,
                  index: orderOf(current.imageId),
                })
              : t('batch.progress', {
                  done: batchDoneCount(batch.items),
                  total: batch.items.length,
                })
            : t('batch.remaining', { count: remaining.length })}
          {!running && skipped.length > 0 && (
            <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
              {t('batch.skipped', { count: skipped.length })}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {running && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              <Pending
                label={batch.stage ? productShotStageLabels()[batch.stage] : t('batch.running')}
                startedAt={batch.startedAt}
              />
            </span>
          )}
          {running ? (
            <button
              type="button"
              onClick={stopBatch}
              disabled={batch.stopRequested}
              className={OUTLINE_BUTTON}
            >
              {batch.stopRequested ? t('batch.stopAfterCurrent') : t('batch.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runBatch()}
              disabled={remaining.length === 0 || swapStage !== null}
              className={PRIMARY_BUTTON}
            >
              {t('batch.run')}
            </button>
          )}
        </div>
      </div>

      {batch && batch.items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {batch.items.map((item) => (
            <li
              key={item.imageId}
              data-product-shots-batch-item
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-gray-700 dark:text-gray-200">
                {t('source.label', { index: orderOf(item.imageId) })}
              </span>
              <span className={STATE_STYLES[item.state]}>
                {productShotBatchStateLabels()[item.state]}
              </span>
              <BadgeTag
                badge={sourceMatteBadge(matteOf(item.imageId), matting.includes(item.imageId))}
                className="px-1 py-0.5 text-[11px]"
              />
              {item.error && (
                <span className="min-w-0 break-words text-red-600 dark:text-red-300">
                  {item.error}
                </span>
              )}
              {item.state === 'error' && (
                <button
                  type="button"
                  onClick={() => void runBatchImage(item.imageId)}
                  disabled={running}
                  className={GHOST_BUTTON}
                >
                  {t('batch.retryOne')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
