import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
import { CARD, GHOST_BUTTON, OUTLINE_BUTTON, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { batchDoneCount, pendingBatchImageIds, skippedDiagramImageIds } from '../lib/batch'
import { useBgSwapStore } from '../store'
import {
  BG_SWAP_BATCH_STATE_LABELS,
  BG_SWAP_STAGE_LABELS,
  type BgSwapBatchItemState,
} from '../types'

const STATE_STYLES: Record<BgSwapBatchItemState, string> = {
  pending: 'text-gray-500 dark:text-gray-400',
  running: 'text-blue-700 dark:text-blue-300',
  done: 'text-emerald-700 dark:text-emerald-300',
  error: 'text-red-600 dark:text-red-300',
}

export default function BgSwapBatchBar() {
  const images = useBgSwapStore(useShallow((s) => s.draft.images))
  const selectedImageId = useBgSwapStore((s) => s.selectedImageId)
  const swapStage = useBgSwapStore((s) => s.swapStage)
  const batch = useBgSwapStore((s) => s.batch)

  const { runBatch, runBatchImage, stopBatch } = useBgSwapStore.getState()
  const remaining = pendingBatchImageIds(images, selectedImageId)
  const skipped = skippedDiagramImageIds(images, selectedImageId)
  const orderOf = (imageId: string) => images.findIndex((image) => image.imageId === imageId) + 1
  const running = batch?.running === true
  const current = batch?.items.find((item) => item.state === 'running')

  return (
    <section data-bgswap-batch className={`${CARD} mt-4 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-700 dark:text-gray-200">
          {running
            ? `批量 ${batchDoneCount(batch.items)}/${batch.items.length}${
                current ? ` · 原图 ${orderOf(current.imageId)}` : ''
              }`
            : `对剩下的 ${remaining.length} 张全部按同样方式跑`}
          {!running && skipped.length > 0 && (
            <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
              已跳过 {skipped.length} 张示意图
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {running && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              <Pending
                label={batch.stage ? BG_SWAP_STAGE_LABELS[batch.stage] : '批量中'}
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
              {batch.stopRequested ? '本张跑完即停' : '停止'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runBatch()}
              disabled={remaining.length === 0 || swapStage !== null}
              className={PRIMARY_BUTTON}
            >
              批量跑
            </button>
          )}
        </div>
      </div>

      {batch && batch.items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {batch.items.map((item) => (
            <li
              key={item.imageId}
              data-bgswap-batch-item
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-gray-700 dark:text-gray-200">原图 {orderOf(item.imageId)}</span>
              <span className={STATE_STYLES[item.state]}>
                {BG_SWAP_BATCH_STATE_LABELS[item.state]}
              </span>
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
                  重跑这张
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
