import type React from 'react'
import { useEffect, useState } from 'react'
import { startVideoFromImage } from '../features/canvas/lib/startVideoFromImage'
import { useLibraryStore } from '../features/library/store'
import { describeError, useTranslation } from '../i18n'
import { isVideoModeAvailable } from '../lib/channels/videoChannels'
import { copyBlobToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { editImageInComposer, ensureImageCached, storeImageFromUrl, useStore } from '../store'
import ContextMenu, { ContextMenuItem } from './ContextMenu'
import { CopyIcon, DownloadIcon, EditIcon, LibraryIcon, VideoIcon } from './icons'

export default function ImageContextMenu() {
  const { t } = useTranslation(['task', 'common'])
  const [menuInfo, setMenuInfo] = useState<{
    src: string
    imageId?: string
    x: number
    y: number
  } | null>(null)
  const showToast = useStore((s) => s.showToast)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const startNamingAsset = useLibraryStore((s) => s.startNaming)

  useEffect(() => {
    if (isEmbeddedPage()) return

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target && target.tagName === 'IMG') {
        const imgTarget = target as HTMLImageElement
        // 忽略没有 src 或空的 img
        if (!imgTarget.src) return

        // iOS 触控设备上，放行原生长按菜单（以支持原生保存图片）
        const isIOS =
          /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        const isTouch = window.matchMedia('(pointer: coarse)').matches
        if (isIOS && isTouch) return

        e.preventDefault()
        setMenuInfo({
          src: imgTarget.src,
          imageId: imgTarget.dataset.imageId,
          x: e.clientX,
          y: e.clientY,
        })
      }
    }

    // 监听全局 contextmenu，兼容桌面端右键和大部分移动端长按
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  if (!menuInfo) return null

  const getOriginalImageSrc = async () => {
    if (!menuInfo.imageId) return menuInfo.src
    return (await ensureImageCached(menuInfo.imageId)) ?? menuInfo.src
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    try {
      const src = await getOriginalImageSrc()
      const res = await fetch(src)
      const blob = await res.blob()
      await copyBlobToClipboard(blob)
      showToast(t('menu.imageCopied'), 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage(t('common:toast.copyFailed'), err), 'error')
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    try {
      const src = await getOriginalImageSrc()
      const res = await fetch(src)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = blob.type.split('/')[1] || 'png'
      a.download = `image-${Date.now()}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showToast(t('download.start'), 'success')
    } catch (err) {
      console.error(err)
      showToast(t('download.failed'), 'error')
    }
  }

  const handleEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    try {
      const src = await getOriginalImageSrc()
      const { id, dataUrl } = await storeImageFromUrl(src)
      // 准入、去重与遮罩编辑器的打开都归这一条改图路径，被拒的理由它自己提示。
      if (!editImageInComposer({ id, dataUrl })) return
      setDetailTaskId(null)
      setLightboxImageId(null)
    } catch (err) {
      console.error(err)
      showToast(t('menu.addReferenceFailed', { reason: describeError(err) }), 'error')
    }
  }

  // 菜单是全局的，右键的图未必进过 image store，落盘拿到 id 才能交给下一步。
  const withStoredImage = (
    describeFailure: (reason: string) => string,
    run: (imageId: string) => void,
  ) => {
    return async (e: React.MouseEvent) => {
      e.stopPropagation()
      const { imageId, src } = menuInfo
      setMenuInfo(null)
      try {
        run(imageId ?? (await storeImageFromUrl(src)).id)
      } catch (err) {
        console.error(err)
        showToast(describeFailure(describeError(err)), 'error')
      }
    }
  }

  return (
    <ContextMenu
      x={menuInfo.x}
      y={menuInfo.y}
      onClose={() => setMenuInfo(null)}
      onOutsidePointer={(target) => {
        if (target instanceof Element && target.closest('[data-lightbox-root]')) {
          window.dispatchEvent(new Event('image-context-menu-dismiss-lightbox-click'))
        }
      }}
    >
      <ContextMenuItem
        icon={<CopyIcon className="w-4 h-4 flex-shrink-0" />}
        label={t('common:action.copy')}
        onClick={handleCopy}
      />
      <ContextMenuItem
        icon={<DownloadIcon className="w-4 h-4 flex-shrink-0" />}
        label={t('common:action.download')}
        onClick={handleDownload}
      />
      <ContextMenuItem
        icon={<EditIcon className="w-4 h-4 flex-shrink-0" />}
        label={t('common:action.edit')}
        onClick={handleEdit}
      />
      <ContextMenuItem
        icon={<LibraryIcon className="w-4 h-4 flex-shrink-0" />}
        label={t('menu.saveAsAsset')}
        onClick={withStoredImage(
          (reason) => t('menu.saveAsAssetFailed', { reason }),
          startNamingAsset,
        )}
      />
      {isVideoModeAvailable() && (
        <ContextMenuItem
          icon={<VideoIcon className="w-4 h-4 flex-shrink-0" />}
          label={t('menu.makeVideo')}
          onClick={withStoredImage(
            (reason) => t('menu.makeVideoFailed', { reason }),
            startVideoFromImage,
          )}
        />
      )}
    </ContextMenu>
  )
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
