import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ACTIVE_SEGMENT,
  CARD,
  GHOST_BUTTON,
  IDLE_SEGMENT,
  SEGMENT,
} from '../../../components/panelStyles'
import { useImageThumbnail } from '../../../hooks/useImageThumbnail'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { sourceMatteBadge } from '../lib/matteBadge'
import { useProductShotsStore } from '../store'
import { editMaskLabel, matteEditable } from '../types'
import WorkflowImage from '../workflows/WorkflowImage'
import BadgeTag from './BadgeTag'
import PreviewToolbar from './PreviewToolbar'

export default function PreviewPanel() {
  const { t } = useTranslation('productShots')
  const images = useProductShotsStore(useShallow((s) => s.draft.images))
  const selectedImageId = useProductShotsStore((s) => s.selectedImageId)
  const previewVersionId = useProductShotsStore((s) => s.previewVersionId)
  const matteOverlayVersionId = useProductShotsStore((s) => s.matteOverlayVersionId)
  const matting = useProductShotsStore((s) =>
    s.selectedImageId === null ? false : s.mattingImageIds.includes(s.selectedImageId),
  )
  const matteOverlayHidden = useStore((s) => s.matteOverlayHidden)
  const setMatteOverlayHidden = useStore((s) => s.setMatteOverlayHidden)
  const tasks = useStore((s) => s.tasks)
  const [comparing, setComparing] = useState(false)
  useEffect(() => {
    setComparing(false)
  }, [selectedImageId, previewVersionId, matteOverlayVersionId])

  const { previewVersion, editSourceMask } = useProductShotsStore.getState()
  const selected = images.find((image) => image.imageId === selectedImageId)
  const index = images.findIndex((image) => image.imageId === selectedImageId)
  const versions = selected?.versions ?? []
  const previewed = versions.find((version) => version.id === previewVersionId)
  // 看蒙版时压过版本预览：蒙版是抠原图抠出来的，只有盖在原图上才说明问题。
  const overlaid = versions.find(
    (version) => version.id === matteOverlayVersionId && version.mattePreviewImageId,
  )
  const previewTask = tasks.find((task) => task.id === previewed?.taskId)
  const canUseResult = Boolean(
    previewed && !overlaid && previewTask?.status === 'done' && previewTask.outputImages[0],
  )
  const shownImageId = previewed && !overlaid ? previewTask?.outputImages[0] : selected?.imageId
  const label = overlaid
    ? t('preview.maskLabel', { index: index + 1 })
    : previewed
      ? t('version.label', { index: versions.indexOf(previewed) + 1 })
      : t('source.label', { index: index + 1 })
  const matte = selected?.sourceMatte
  const onOriginal = selected !== undefined && previewed === undefined && overlaid === undefined
  const thumbnail = useImageThumbnail(shownImageId)
  // 某一版的「看蒙版」压过原图身上那份：要核对的是这一版实际用掉的蒙版。
  const overlay = useImageThumbnail(
    overlaid?.mattePreviewImageId ??
      (onOriginal && !matteOverlayHidden ? (matte?.previewImageId ?? undefined) : undefined),
  )

  return (
    <section data-product-shots-column="preview" className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {selected ? label : t('preview.title')}
        </h2>
        <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900">
          <button
            type="button"
            onClick={() => previewVersion(null)}
            aria-pressed={previewed === undefined}
            className={`${SEGMENT} ${previewed ? IDLE_SEGMENT : ACTIVE_SEGMENT}`}
          >
            {t('source.original')}
          </button>
          <button
            type="button"
            onClick={() => previewVersion(versions[versions.length - 1]?.id ?? null)}
            disabled={versions.length === 0}
            aria-pressed={previewed !== undefined}
            className={`${SEGMENT} ${previewed ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
          >
            {t('preview.currentVersion')}
          </button>
        </div>
      </div>

      {comparing && canUseResult ? (
        <div aria-label={t('preview.compare')} className="grid grid-cols-2 gap-2">
          <figure className="min-w-0">
            <WorkflowImage
              imageId={previewed?.workflow?.sourceImageId ?? selected?.imageId}
              alt={t('workspace.before')}
              className="aspect-[3/4] max-h-[min(50dvh,32rem)] w-full rounded-xl border border-gray-200 bg-gray-50 object-contain dark:border-white/[0.08] dark:bg-white/[0.02]"
            />
            <figcaption className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
              {previewed?.workflow ? t('workspace.before') : t('source.original')}
            </figcaption>
          </figure>
          <figure className="min-w-0">
            <WorkflowImage
              imageId={shownImageId}
              version={previewed}
              alt={label}
              className="aspect-[3/4] max-h-[min(50dvh,32rem)] w-full rounded-xl border border-gray-200 bg-gray-50 object-contain dark:border-white/[0.08] dark:bg-white/[0.02]"
            />
            <figcaption className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
              {label}
            </figcaption>
          </figure>
        </div>
      ) : (
        <div className="flex aspect-[4/3] max-h-[min(50dvh,32rem)] items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.02]">
          {thumbnail?.dataUrl ? (
            <span className="relative block h-full w-full">
              <WorkflowImage
                imageId={shownImageId}
                version={overlaid ? undefined : previewed}
                alt={label}
                className="h-full w-full object-contain"
              />
              {overlay?.dataUrl && (
                <img
                  src={overlay.dataUrl}
                  alt={t('matte.mask')}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              )}
            </span>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {previewed ? t('preview.noVersionImage') : t('preview.noSource')}
            </span>
          )}
        </div>
      )}
      <PreviewToolbar
        key={canUseResult ? previewed?.id : 'unavailable'}
        version={canUseResult ? previewed : undefined}
        imageId={canUseResult ? shownImageId : undefined}
        imageIndex={index}
        versionIndex={previewed ? versions.indexOf(previewed) : -1}
        comparing={canUseResult && comparing}
        onCompare={() => setComparing((value) => !value)}
        disabledReason={
          !selected
            ? t('preview.disabled.noSource')
            : !previewed || overlaid
              ? t('preview.disabled.noVersion')
              : previewTask?.status === 'running'
                ? t('preview.disabled.running')
                : t('preview.disabled.noResult')
        }
      />

      {onOriginal && (matte || matting) && (
        <div data-product-shots-matte-bar className="mt-2 flex flex-wrap items-center gap-2">
          {matte?.previewImageId && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={!matteOverlayHidden}
                onChange={(e) => setMatteOverlayHidden(!e.target.checked)}
              />
              {t('preview.showMask')}
            </label>
          )}
          <BadgeTag
            badge={sourceMatteBadge(matte, matting)}
            className="px-1.5 py-0.5 text-[11px] leading-tight"
          />
          {matteEditable(matte) && (
            <button
              type="button"
              onClick={() => void editSourceMask(selected.imageId)}
              className={`ml-auto ${GHOST_BUTTON}`}
            >
              {editMaskLabel()}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
