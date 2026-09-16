import { STORYBOARD_MAX_REFERENCE_IMAGES } from '@image-playground/shared'
import { useRef, useState } from 'react'
import { GHOST_BUTTON, LABEL } from '../../../../components/panelStyles'
import { useImageDropZone } from '../../../../hooks/useImageDropZone'
import { useTranslation } from '../../../../i18n'
import { acceptImageFiles } from '../../../../lib/imageFiles'
import AssetThumb from '../../../library/components/AssetThumb'
import FramePicker from '../../components/FramePicker'
import FrameSourceStrip from '../../components/FrameSourceStrip'
import { useStoryboardStore } from '../store'

function addFiles(files: File[]): void {
  void useStoryboardStore.getState().addReferencesFromFiles(files)
}

/** 分镜自己的参考图：最多 4 张，加、减都在这里，和图生视频的首帧互不相干。 */
export default function StoryboardReferences() {
  const { t } = useTranslation(['video', 'common'])
  const referenceLabel = t('references.label')
  const referenceImageIds = useStoryboardStore((s) => s.draft.referenceImageIds)
  const [picking, setPicking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { dragging, dropZoneProps } = useImageDropZone(addFiles)
  const full = referenceImageIds.length >= STORYBOARD_MAX_REFERENCE_IMAGES
  const toggle = (imageId: string) => useStoryboardStore.getState().toggleReference(imageId)

  return (
    <div>
      <div className={`${LABEL} mb-1.5`}>
        {t('references.caption', { max: STORYBOARD_MAX_REFERENCE_IMAGES })}
      </div>
      <ul aria-label={referenceLabel} className="grid grid-cols-4 gap-2">
        {referenceImageIds.map((imageId) => (
          <li
            key={imageId}
            className="relative aspect-square overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]"
          >
            <AssetThumb imageId={imageId} alt={referenceLabel} />
            <button
              type="button"
              onClick={() => useStoryboardStore.getState().removeReference(imageId)}
              aria-label={t('frameSlot.removeAria', { label: referenceLabel })}
              className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-[11px] text-white"
            >
              ×
            </button>
          </li>
        ))}
        {!full && (
          <li
            {...dropZoneProps}
            className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-center transition ${
              dragging
                ? 'border-blue-400 bg-blue-500/5'
                : 'border-gray-300 dark:border-white/[0.14]'
            }`}
          >
            <button
              type="button"
              className={GHOST_BUTTON}
              onClick={() => inputRef.current?.click()}
            >
              {t('common:action.upload')}
            </button>
            <button type="button" className={GHOST_BUTTON} onClick={() => setPicking(true)}>
              {t('action.pickImage')}
            </button>
          </li>
        )}
      </ul>

      <FrameSourceStrip
        showLastFrame={false}
        fillLabel={t('frameStrip.fill', { label: referenceLabel })}
        selectedImageIds={referenceImageIds}
        onSelect={toggle}
        onPickAll={() => setPicking(true)}
      />

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          addFiles(acceptImageFiles([...(event.target.files ?? [])]))
          event.target.value = ''
        }}
      />

      {picking && (
        <FramePicker
          label={referenceLabel}
          selectedImageIds={referenceImageIds}
          onSelect={toggle}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}
