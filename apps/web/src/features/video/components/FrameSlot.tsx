import { useRef } from 'react'
import { GHOST_BUTTON } from '../../../components/panelStyles'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { acceptImageFiles } from '../../../lib/imageFiles'
import AssetThumb from '../../library/components/AssetThumb'
import { useVideoStore } from '../store'
import { VIDEO_FRAME_SLOT_LABELS, type VideoFrameSlot } from '../types'

interface FrameSlotProps {
  slot: VideoFrameSlot
  imageId: string | null
  /** 有值即置灰，并把原因写在槽里。 */
  disabledReason?: string
  hint?: string
  onPick: () => void
}

export default function FrameSlot({ slot, imageId, disabledReason, hint, onPick }: FrameSlotProps) {
  const label = VIDEO_FRAME_SLOT_LABELS[slot]
  const inputRef = useRef<HTMLInputElement>(null)
  const disabled = Boolean(disabledReason)
  const { dragging, dropZoneProps } = useImageDropZone((files) => {
    if (!disabled && files[0]) void useVideoStore.getState().addFrameFromFile(slot, files[0])
  })

  if (imageId) {
    return (
      <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
        <AssetThumb imageId={imageId} alt={label} />
        <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[10px] text-white">
          {label}
        </span>
        <button
          type="button"
          onClick={() => useVideoStore.getState().setFrame(slot, null)}
          aria-label={`移除${label}`}
          className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-[11px] text-white"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div
      {...dropZoneProps}
      aria-disabled={disabled}
      className={`flex aspect-[16/10] flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-center transition ${
        disabled
          ? 'border-gray-200 opacity-55 dark:border-white/[0.08]'
          : dragging
            ? 'border-blue-400 bg-blue-500/5'
            : 'border-gray-300 dark:border-white/[0.14]'
      }`}
    >
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      {(disabledReason ?? hint) && (
        <span className="px-2 text-[11px] text-gray-400 dark:text-gray-500">
          {disabledReason ?? hint}
        </span>
      )}
      {!disabled && (
        <div className="flex items-center gap-1">
          <button type="button" className={GHOST_BUTTON} onClick={() => inputRef.current?.click()}>
            上传
          </button>
          <button type="button" className={GHOST_BUTTON} onClick={onPick}>
            选图
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const files = acceptImageFiles([...(event.target.files ?? [])])
          if (files[0]) void useVideoStore.getState().addFrameFromFile(slot, files[0])
          event.target.value = ''
        }}
      />
    </div>
  )
}
