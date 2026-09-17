import { useEffect, useState } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { CopyIcon, DownloadIcon } from '../../../components/icons'
import { ImagePreview } from '../../../components/Lightbox'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { copyBlobToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { downloadBlob } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import type { CanvasDoc } from '../lib/canvasDoc'

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
  const showToast = useStore.getState().showToast

  const copy = async () => {
    onClose()
    try {
      await copyBlobToClipboard(await dataUrlToBlob(dataUrl))
      showToast(t('imageMenu.copied'), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(t('common:toast.copyFailed'), err), 'error')
    }
  }
  const download = async () => {
    onClose()
    try {
      const blob = await dataUrlToBlob(dataUrl)
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
      downloadBlob(blob, `canvas-${menu.id}.${ext}`)
    } catch {
      showToast(t('imageMenu.downloadFailed'), 'error')
    }
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
        label={t('imageMenu.preview')}
        onClick={() => setPreview(true)}
      />
      <ContextMenuItem
        icon={<CopyIcon className="h-4 w-4" />}
        label={t('imageMenu.copy')}
        onClick={() => void copy()}
      />
      <ContextMenuItem
        icon={<DownloadIcon className="h-4 w-4" />}
        label={t('imageMenu.download')}
        onClick={() => void download()}
      />
    </ContextMenu>
  )
}
