import { useRef, useState } from 'react'
import { Button, Icon, Overlay } from '../../lib/privateHost'
import {
  type CropImageSize,
  type CropOffset,
  canvasToPng,
  clampCropOffset,
  coverScale,
  drawCroppedAvatar,
} from './avatar-crop'
import { tBilling, useTranslation } from './i18n'
import { useMediaQuery } from './useMediaQuery'

const ZOOM_MIN = 1
const ZOOM_MAX = 3

export function AvatarCropFrame({
  imageUrl,
  sheet,
  saving,
  onClose,
  onReselect,
  onConfirm,
  onError,
}: {
  imageUrl: string
  sheet: boolean
  saving: boolean
  onClose: () => void
  onReselect: () => void
  onConfirm: (blob: Blob) => void
  onError: () => void
}) {
  useTranslation()
  const frameRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; offset: CropOffset } | null>(null)
  const [size, setSize] = useState<CropImageSize | null>(null)
  const [zoom, setZoom] = useState(ZOOM_MIN)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 })

  const viewport = frameRef.current?.clientWidth || 240
  const scale = size ? coverScale(size, viewport, rotation) * zoom : 1
  const drawWidth = size ? size.width * scale : undefined
  const drawHeight = size ? size.height * scale : undefined

  function reclamp(next: CropOffset, nextZoom = zoom, nextRotation = rotation): CropOffset {
    if (!size) return next
    const currentViewport = frameRef.current?.clientWidth || viewport
    return clampCropOffset(next, size, currentViewport, nextZoom, nextRotation)
  }

  async function confirm(): Promise<void> {
    const image = imageRef.current
    if (!image || !size || saving) return
    const currentViewport = frameRef.current?.clientWidth || viewport
    const clamped = clampCropOffset(offset, size, currentViewport, zoom, rotation)
    try {
      const blob = await canvasToPng(
        drawCroppedAvatar(image, size, clamped, currentViewport, zoom, rotation),
      )
      onConfirm(blob)
    } catch {
      onError()
    }
  }

  return (
    <div
      data-crop-layout={sheet ? 'sheet' : 'dialog'}
      className={
        sheet
          ? 'absolute inset-x-0 bottom-0 flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-card text-foreground shadow-dialog'
          : 'flex max-h-[90dvh] w-full max-w-sm flex-col overflow-hidden rounded-3xl bg-card text-foreground shadow-dialog ring-1 ring-hairline'
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-3 pb-2 pl-6 pr-3 pt-4">
        <h2 className="min-w-0 truncate text-xl font-semibold">{tBilling('settings.cropTitle')}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tBilling('settings.closeCrop')}
          onClick={onClose}
          disabled={saving}
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div
          ref={frameRef}
          className="relative mx-auto h-60 w-60 overflow-hidden rounded-full bg-muted ring-2 ring-primary"
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            if (!size) return
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { x: event.clientX, y: event.clientY, offset }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || !size) return
            setOffset(
              reclamp({
                x: drag.offset.x + event.clientX - drag.x,
                y: drag.offset.y + event.clientY - drag.y,
              }),
            )
          }}
          onPointerUp={() => {
            dragRef.current = null
          }}
          onPointerCancel={() => {
            dragRef.current = null
          }}
        >
          <img
            ref={imageRef}
            src={imageUrl}
            alt=""
            draggable={false}
            className="absolute max-w-none select-none"
            style={
              drawWidth && drawHeight
                ? {
                    width: drawWidth,
                    height: drawHeight,
                    left: viewport / 2 + offset.x - drawWidth / 2,
                    top: viewport / 2 + offset.y - drawHeight / 2,
                    transform: `rotate(${rotation}deg)`,
                  }
                : { width: '100%', height: '100%', objectFit: 'cover' }
            }
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) {
                setSize({ width: naturalWidth, height: naturalHeight })
              }
            }}
          />
        </div>
        <div className="mt-5">
          <span className="sr-only">{tBilling('settings.zoom')}</span>
          <Slider
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.01}
            value={[zoom]}
            aria-label={tBilling('settings.zoom')}
            disabled={saving}
            className="w-full"
            onValueChange={([next]) => {
              if (next === undefined) return
              setZoom(next)
              setOffset((current) => reclamp(current, next))
            }}
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={tBilling('settings.rotate')}
            disabled={saving}
            onClick={() => {
              const next = (rotation + 90) % 360
              setRotation(next)
              setOffset((current) => reclamp(current, zoom, next))
            }}
          >
            <Icon name="rotate" />
          </Button>
          <p className="text-xs text-muted-foreground">{tBilling('settings.cropHint')}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
        <Button type="button" variant="outline" onClick={onReselect} disabled={saving}>
          {tBilling('settings.reselect')}
        </Button>
        <Button type="button" onClick={() => void confirm()} disabled={saving || !size}>
          {saving ? <Icon name="loading" size="xs" className="animate-spin" /> : null}
          {tBilling(saving ? 'settings.uploading' : 'settings.useAvatar')}
        </Button>
      </div>
    </div>
  )
}

export function AvatarCropDialog(props: {
  imageUrl: string
  saving: boolean
  onClose: () => void
  onReselect: () => void
  onConfirm: (blob: Blob) => void
  onError: () => void
}) {
  const sheet = useMediaQuery('(max-width: 767px)')
  return (
    <Overlay onClose={props.onClose} tier="raised" role="none" layout={sheet ? 'fill' : 'center'}>
      <AvatarCropFrame {...props} sheet={sheet} />
    </Overlay>
  )
}
