import type { PlanPrice } from '@image-playground/shared'
import { useState } from 'react'
import { Button, DialogSurface, Icon, Overlay } from '../../lib/privateHost'
import { type ContactChannels, isDiscounted, periodLabel } from './billing-display'
import { formatMoney } from './billing-store'
import { tBilling, useTranslation } from './i18n'

interface QrTileData {
  src: string
  alt: string
  label: string
}

function QrTile({ tile, onZoom }: { tile: QrTileData; onZoom: () => void }) {
  return (
    <figure className="text-center">
      <Button
        variant="ghost"
        type="button"
        onClick={onZoom}
        aria-label={tBilling('contact.zoomIn', { label: tile.label })}
        className="h-auto cursor-zoom-in p-0"
      >
        {/* 媒体预览触发器随二维码内容定高，保留整图点击放大。 */}
        <img
          src={tile.src}
          alt={tile.alt}
          className="h-44 w-44 rounded-md bg-on-media p-2 object-contain"
        />
      </Button>
      <figcaption className="mt-2 text-xs text-muted-foreground">{tile.label}</figcaption>
    </figure>
  )
}

/** 二维码要能被扫，所以放大层撑到视口短边而不是原图尺寸，并始终垫白底。 */
export function QrZoomSurface({ tile, onClose }: { tile: QrTileData; onClose: () => void }) {
  useTranslation()
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tBilling('contact.zoomTitle', { label: tile.label })}
      onClick={onClose}
      className="relative animate-zoom-in cursor-zoom-out"
    >
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        aria-label={tBilling('contact.closeAria')}
        className="mb-2 ml-auto flex"
      >
        <Icon name="close" />
      </Button>
      <img
        src={tile.src}
        alt={tile.alt}
        onDragStart={(event) => event.preventDefault()}
        className="h-[min(85dvh,85vw)] w-[min(85dvh,85vw)] rounded-3xl bg-on-media object-contain p-4 shadow-dialog"
      />
    </div>
  )
}

function QrZoom({ tile, onClose }: { tile: QrTileData; onClose: () => void }) {
  return (
    <Overlay onClose={onClose} tier="alert" role="none">
      <QrZoomSurface tile={tile} onClose={onClose} />
    </Overlay>
  )
}

interface ContactSurfaceProps {
  title: string
  price: PlanPrice | null
  channels: ContactChannels
  onClose: () => void
}

/** 表面与 Overlay 分开导出：react-dom/server 渲染不了 portal，测试只能渲染表面。 */
export function ContactSurface({ title, price, channels, onClose }: ContactSurfaceProps) {
  useTranslation()
  const { paymentQr, contact, guidance } = channels
  const [zoomedQr, setZoomedQr] = useState<QrTileData | null>(null)
  const paymentQrLabel = tBilling('contact.paymentQr')
  const qrTiles: QrTileData[] = [
    paymentQr === null ? null : { src: paymentQr, alt: paymentQrLabel, label: paymentQrLabel },
    contact.kind === 'qr'
      ? {
          src: contact.src,
          alt: tBilling('contact.wechatQrAlt'),
          label: tBilling('contact.wechatLabel'),
        }
      : null,
  ].filter((tile) => tile !== null)

  return (
    <DialogSurface title={title} onClose={onClose} className="max-w-lg">
      {price ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-muted-foreground">{periodLabel(price.period_months)}</span>
          <span className="text-xl font-semibold text-foreground">
            {formatMoney(price.effective_price_cents)}
          </span>
          {isDiscounted(price) ? (
            <del className="text-sm text-muted-foreground">
              {formatMoney(price.original_price_cents)}
            </del>
          ) : null}
        </div>
      ) : null}

      {qrTiles.length > 0 ? (
        <div className="mt-6 flex flex-wrap justify-center gap-6">
          {qrTiles.map((tile) => (
            <QrTile key={tile.label} tile={tile} onZoom={() => setZoomedQr(tile)} />
          ))}
        </div>
      ) : null}

      {contact.kind === 'wechat' ? (
        <p className="mt-6 rounded-2xl bg-card p-4 text-sm text-foreground">
          {tBilling('contact.wechatHandle', { handle: contact.text })}
        </p>
      ) : null}

      {guidance ? <p className="mt-6 text-sm leading-6 text-muted-foreground">{guidance}</p> : null}

      {zoomedQr ? <QrZoom tile={zoomedQr} onClose={() => setZoomedQr(null)} /> : null}
    </DialogSurface>
  )
}

export function ContactModal(props: ContactSurfaceProps) {
  return (
    <Overlay onClose={props.onClose} tier="raised" role="none">
      <ContactSurface {...props} />
    </Overlay>
  )
}
