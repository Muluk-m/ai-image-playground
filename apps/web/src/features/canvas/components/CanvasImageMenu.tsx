import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { CopyIcon, DownloadIcon } from '../../../components/icons'
import { ImagePreview } from '../../../components/Lightbox'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import type { CanvasDoc } from '../lib/canvasDoc'
import { copyCanvasImage, downloadCanvasImage } from '../lib/canvasImageActions'

export interface CanvasImageMenuState {
  readonly id: string
  readonly x: number
  readonly y: number
}

/**
 * 画布图片的右键菜单。浏览器原生的「复制图片 / 图片存储为」抓的是最上面那张 Konva
 * 图层的位图——选区框那层，几乎是空的，存下来就是一张白板。这里直接从画布存档里
 * 取原始位图，复制和下载的都是真正那张图。
 */
export default function CanvasImageMenu({
  menu,
  doc,
  onClose,
}: {
  menu: CanvasImageMenuState | null
  doc: CanvasDoc
  onClose: () => void
}) {
  const { t } = useTranslation(['canvas', 'common'])
  const [preview, setPreview] = useState(false)
  const [previewSrc, setPreviewSrc] = useState('')
  const [previewFailed, setPreviewFailed] = useState(false)
  // 「长按保存」只对触屏成立；用鼠标的设备在预览里右键另存，不必提。
  const [coarsePointer] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false)
  useEffect(() => {
    setPreview(false)
    setPreviewSrc('')
    setPreviewFailed(false)
  }, [menu?.id])
  const element = menu ? doc.getElement(menu.id) : undefined
  const dataUrl = element?.type === 'image' ? doc.files[element.fileId] : undefined
  useEffect(() => {
    if (!preview || !dataUrl) return
    let cancelled = false
    void resolveMediaSource(dataUrl)
      .then((src) => {
        if (!cancelled) setPreviewSrc(src)
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [preview, dataUrl])
  if (!menu) return null
  if (!dataUrl) return null
  const copy = () => {
    onClose()
    void copyCanvasImage(dataUrl)
  }
  const download = () => {
    onClose()
    void downloadCanvasImage(dataUrl, menu.id)
  }

  if (preview)
    return previewSrc ? (
      <ImagePreview src={previewSrc} onClose={onClose} />
    ) : (
      <Overlay onClose={onClose}>
        <div className="rounded-xl bg-card p-6 text-foreground" role="status">
          {previewFailed ? t('imageMenu.previewFailed') : t('imageMenu.loading')}
          <button type="button" className="ml-4 min-h-11 underline" onClick={onClose}>
            {t('common:action.close')}
          </button>
        </div>
      </Overlay>
    )

  return (
    <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      <ContextMenuItem
        icon={<span aria-hidden="true">↗</span>}
        label={t(coarsePointer ? 'imageMenu.previewTouch' : 'imageMenu.preview')}
        onClick={() => setPreview(true)}
      />
      <ContextMenuItem
        icon={<CopyIcon className="h-4 w-4" />}
        label={t('imageMenu.copy')}
        onClick={copy}
      />
      <ContextMenuItem
        icon={<DownloadIcon className="h-4 w-4" />}
        label={t('imageMenu.download')}
        onClick={download}
      />
      <ContextMenuItem
        icon={<Trash2 className="h-4 w-4" />}
        label={t('imageMenu.delete')}
        onClick={() => {
          onClose()
          doc.deleteElements([menu.id])
        }}
      />
    </ContextMenu>
  )
}
