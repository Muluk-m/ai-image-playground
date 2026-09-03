import type React from 'react'
import { useEffect, useState } from 'react'
import { useLibraryStore } from '../features/library/store'
import { getActiveApiProfile } from '../lib/apiProfiles'
import { modelSupportsEdit, NO_EDIT_SUPPORT_MESSAGE } from '../lib/channels/profileSelectors'
import { getPublicChannels } from '../lib/channels/publicChannels'
import { copyBlobToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { addImageFromUrl, ensureImageCached, storeImageFromUrl, useStore } from '../store'
import ContextMenu, { ContextMenuItem } from './ContextMenu'
import { CopyIcon, DownloadIcon, EditIcon, LibraryIcon } from './icons'

export default function ImageContextMenu() {
  const [menuInfo, setMenuInfo] = useState<{
    src: string
    imageId?: string
    x: number
    y: number
  } | null>(null)
  const showToast = useStore((s) => s.showToast)
  const inputImages = useStore((s) => s.inputImages)
  const settings = useStore((s) => s.settings)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
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
      showToast('图片已复制', 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
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
      showToast('开始下载', 'success')
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
  }

  const handleEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    if (!modelSupportsEdit(getActiveApiProfile(settings), getPublicChannels())) {
      showToast(NO_EDIT_SUPPORT_MESSAGE, 'error')
      return
    }
    if (inputImages.length >= 16) {
      showToast('参考图数量已达上限（16 张），无法继续添加', 'error')
      return
    }

    try {
      const src = await getOriginalImageSrc()
      const id = await addImageFromUrl(src)
      setDetailTaskId(null)
      setLightboxImageId(null)
      // 加入参考图后直接打开遮罩编辑器对这张图局部编辑
      setMaskEditorImageId(id)
    } catch (err) {
      console.error(err)
      showToast(`加入参考图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleSaveAsset = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const { imageId, src } = menuInfo
    setMenuInfo(null)
    try {
      startNamingAsset(imageId ?? (await storeImageFromUrl(src)).id)
    } catch (err) {
      console.error(err)
      showToast(`存为素材失败：${err instanceof Error ? err.message : String(err)}`, 'error')
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
        label="复制"
        onClick={handleCopy}
      />
      <ContextMenuItem
        icon={<DownloadIcon className="w-4 h-4 flex-shrink-0" />}
        label="下载"
        onClick={handleDownload}
      />
      <ContextMenuItem
        icon={<EditIcon className="w-4 h-4 flex-shrink-0" />}
        label="编辑"
        onClick={handleEdit}
      />
      <ContextMenuItem
        icon={<LibraryIcon className="w-4 h-4 flex-shrink-0" />}
        label="存为素材"
        onClick={handleSaveAsset}
      />
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
