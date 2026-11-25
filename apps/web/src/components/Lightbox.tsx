import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { originalBlob } from '../features/image-export/sources'
import { openImageExport } from '../features/image-export/store'
import { useHistoryTasks } from '../hooks/useHistoryTasks'
import { useImagePreview } from '../hooks/useImagePreview'
import { useTranslation } from '../i18n'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { downloadBlob } from '../lib/downloadImages'
import { loadImageOriginal } from '../lib/imageSource'
import { useStore } from '../store'
import Overlay, { type OverlayTier } from './patterns/Overlay'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

const MIN_SCALE = 1
const MAX_SCALE = 10
/** 手指移出这个距离才算拖动 */
const TOUCH_DRAG_THRESHOLD_PX = 8
/** 未缩放状态下纵向拖出这个距离或抛掷速度即可跟手关闭 */
const DISMISS_DISTANCE_PX = 110
const DISMISS_VELOCITY_PX_MS = 0.55
const VELOCITY_STALE_MS = 100
const FLIP_OPEN_MS = 280
const FLIP_CLOSE_MS = 200
const FLIP_OPEN_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const FLIP_CLOSE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 在视口内定位触发 Lightbox 的原卡片缩略图，供共享元素 FLIP 展开与收回使用。 */
function findSourceImageRect(imageId: string): DOMRect | null {
  if (!imageId || typeof document === 'undefined' || typeof window === 'undefined') return null
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(imageId)
      : imageId.replace(/["\\]/g, '\\$&')
  const candidates = document.querySelectorAll<HTMLElement>(`[data-image-id="${escaped}"]`)
  const vw = window.innerWidth
  const vh = window.innerHeight
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i]
    if (el.closest('[data-lightbox-root]')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 8 || rect.height <= 8) continue
    if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue
    return rect
  }
  return null
}

export default function Lightbox() {
  const { t } = useTranslation(['task', 'common'])
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const maskDraft = useStore((s) => s.maskDraft)
  const tasks = useHistoryTasks()

  const [src, setSrc] = useState('')
  const [originalFailed, setOriginalFailed] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [maskImageSrc, setMaskImageSrc] = useState('')
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const thumbnail = useImagePreview(lightboxImageId ?? undefined)

  const close = useCallback(() => setLightboxImageId(null), [setLightboxImageId])

  // 图片加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setSrc('')
      setOriginalFailed(false)
      return
    }

    setSrc('')
    setOriginalFailed(false)

    void loadImageOriginal(lightboxImageId)
      .then((url) => {
        if (cancelled) return
        if (url) {
          setSrc(url)
        } else {
          setOriginalFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setOriginalFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [lightboxImageId, retryKey])

  // 遮罩图加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setMaskImageSrc('')
      return
    }

    if (maskDraft?.targetImageId === lightboxImageId) {
      setMaskImageSrc(maskDraft.maskDataUrl)
      return
    }

    setMaskImageSrc('')

    const taskWithMask = tasks.find((t) => t.maskTargetImageId === lightboxImageId && t.maskImageId)
    const maskImageId = taskWithMask?.maskImageId
    if (!maskImageId) return
    void loadImageOriginal(maskImageId).then((url) => {
      if (!cancelled && url) setMaskImageSrc(url)
    })

    return () => {
      cancelled = true
    }
  }, [lightboxImageId, maskDraft?.targetImageId, maskDraft?.maskDataUrl, tasks])

  // 生成遮罩预览
  useEffect(() => {
    let cancelled = false
    if (!src || !maskImageSrc) {
      setMaskPreviewSrc('')
      return
    }

    createMaskPreviewDataUrl(src, maskImageSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [src, maskImageSrc])

  // 导航
  const currentIndex = lightboxImageId ? lightboxImageList.indexOf(lightboxImageId) : -1
  const total = lightboxImageList.length
  const showNav = total > 1

  const goTo = useCallback(
    (idx: number) => {
      if (lightboxImageList.length === 0) return
      const wrapped =
        ((idx % lightboxImageList.length) + lightboxImageList.length) % lightboxImageList.length
      setLightboxImageId(lightboxImageList[wrapped], lightboxImageList)
    },
    [lightboxImageList, setLightboxImageId],
  )

  const goPrev = useCallback(() => {
    if (showNav) goTo(currentIndex - 1)
  }, [showNav, currentIndex, goTo])
  const goNext = useCallback(() => {
    if (showNav) goTo(currentIndex + 1)
  }, [showNav, currentIndex, goTo])

  // 键盘左右切换
  useEffect(() => {
    if (!lightboxImageId || !showNav) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxImageId, showNav, goPrev, goNext])

  // 原图读起来是几秒的事（本机几 MB 的 dataURL，平台图整张下载再转 base64）。在它到位前先
  // 铺缩略图，缩略图也没有就先给个转圈——否则点开之后屏幕上什么都不发生，像是没点中。
  const originalPending = !src && !originalFailed
  const displaySrc = src || thumbnail?.url || ''
  if (!lightboxImageId) return null
  if (!displaySrc) {
    return (
      <Overlay
        onClose={close}
        tier="raised"
        backdrop="none"
        layout="fill"
        label={t('lightbox.dialog')}
      >
        <div className="flex h-full w-full items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in" />
          {originalFailed ? (
            <div className="relative flex flex-col items-center gap-3 rounded-2xl bg-black/60 px-5 py-4 text-sm text-white backdrop-blur-sm">
              <p>{t('lightbox.originalFailed')}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRetryKey((k) => k + 1)}
              >
                <Icon name="refresh" size="xs" />
                {t('common:action.retry')}
              </Button>
            </div>
          ) : (
            <Icon name="loading" size="lg" className="relative animate-spin text-white" />
          )}
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="absolute right-4 top-4"
            aria-label={t('common:action.close')}
            onClick={close}
          >
            <Icon name="close" />
          </Button>
        </div>
      </Overlay>
    )
  }

  return (
    <LightboxInner
      src={displaySrc}
      originalPending={originalPending}
      originalFailed={originalFailed}
      onRetryOriginal={() => setRetryKey((k) => k + 1)}
      imageId={lightboxImageId}
      maskPreviewSrc={maskPreviewSrc}
      onClose={close}
      showNav={showNav}
      currentIndex={currentIndex}
      total={total}
      onPrev={goPrev}
      onNext={goNext}
    />
  )
}

/** Preview canvas pixels without importing them into generation history. */
export function ImagePreview({
  src,
  tier,
  onClose,
  originalPending = false,
  originalFailed = false,
  onRetryOriginal,
}: {
  src: string
  tier?: OverlayTier
  onClose: () => void
  originalPending?: boolean
  originalFailed?: boolean
  onRetryOriginal?: () => void
}) {
  return (
    <LightboxInner
      tier={tier}
      src={src}
      originalPending={originalPending}
      originalFailed={originalFailed}
      onRetryOriginal={onRetryOriginal}
      imageId=""
      onClose={onClose}
      showNav={false}
      currentIndex={0}
      total={1}
      onPrev={() => {}}
      onNext={() => {}}
    />
  )
}

interface LightboxInnerProps {
  tier?: OverlayTier
  src: string
  /** 展示的还是缩略图，原图仍在读：下载得等真像素，界面也要说清楚。 */
  originalPending?: boolean
  originalFailed?: boolean
  onRetryOriginal?: () => void
  imageId: string
  maskPreviewSrc?: string
  onClose: () => void
  showNav: boolean
  currentIndex: number
  total: number
  onPrev: () => void
  onNext: () => void
}

/** 内部组件：保证挂载时 DOM 已经存在，所有 ref / effect 都可靠 */
function LightboxInner({
  tier = 'raised',
  src,
  originalPending = false,
  originalFailed = false,
  onRetryOriginal,
  imageId,
  maskPreviewSrc,
  onClose,
  showNav,
  currentIndex,
  total,
  onPrev,
  onNext,
}: LightboxInnerProps) {
  const { t } = useTranslation(['task', 'common', 'toolbox'])
  const containerRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const mediaShellRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const showToast = useStore((s) => s.showToast)
  const originalUnavailable = originalPending || originalFailed

  // 用 ref 追踪最新变换，避免闭包过期
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)
  const closingRef = useRef(false)
  const closeFallbackTimerRef = useRef<number | null>(null)
  const closeCancelRef = useRef<(() => void) | null>(null)
  const initialImageIdRef = useRef(imageId)
  const didOpenFlipRef = useRef(false)
  const pendingOpenFlipRectRef = useRef<DOMRect | null>(null)
  const [usedSharedOpenFlip, setUsedSharedOpenFlip] = useState(false)

  // 未缩放时的跟手拖拽关闭手势状态（iOS Photos 风格：纵向 1:1 跟手 + 背景渐变 + 速度抛掷关闭/回弹）
  const dismissRef = useRef({
    active: false,
    pending: false,
    startX: 0,
    startY: 0,
    lastY: 0,
    lastTime: 0,
    vy: 0,
    dx: 0,
    dy: 0,
  })

  // 仅用于触发渲染
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  // 缩放倍率显示：2s 无操作后自动隐藏
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 拖拽状态。pending = 手指已按下但还没超过阈值，尚未算拖动
  const dragRef = useRef({
    active: false,
    pending: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  })

  // 双指缩放状态
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    midX: 0,
    midY: 0,
  })

  // 双击检测（触控）
  const tapRef = useRef({ time: 0, x: 0, y: 0 })
  const hadMultiTouchRef = useRef(false)
  const touchStartedOnImageRef = useRef(false)

  // 判断本次 mousedown → mouseup 是否发生了拖拽，用于区分点击和拖拽
  const didDragRef = useRef(false)
  const suppressNextClickRef = useRef(false)

  const playOpenFlip = useCallback((fromRect: DOMRect): boolean => {
    const shell = mediaShellRef.current
    if (!shell || typeof shell.animate !== 'function' || prefersReducedMotion()) return false
    const toRect = shell.getBoundingClientRect()
    if (toRect.width <= 8 || toRect.height <= 8) return false
    const dx = fromRect.left + fromRect.width / 2 - (toRect.left + toRect.width / 2)
    const dy = fromRect.top + fromRect.height / 2 - (toRect.top + toRect.height / 2)
    const scale = clamp(
      Math.min(fromRect.width / toRect.width, fromRect.height / toRect.height),
      0.12,
      1,
    )
    shell.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`, opacity: 0.72 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ],
      { duration: FLIP_OPEN_MS, easing: FLIP_OPEN_EASING },
    )
    return true
  }, [])

  // 仅对挂载时的首张图尝试共享元素 FLIP 展开；切到其他图后立刻关闭开场 FLIP。
  useLayoutEffect(() => {
    if (imageId !== initialImageIdRef.current) {
      didOpenFlipRef.current = true
      pendingOpenFlipRectRef.current = null
      return
    }
    if (didOpenFlipRef.current || !imageId || prefersReducedMotion()) return
    const fromRect = findSourceImageRect(imageId)
    if (!fromRect) return
    if (playOpenFlip(fromRect)) {
      didOpenFlipRef.current = true
      setUsedSharedOpenFlip(true)
    } else {
      pendingOpenFlipRectRef.current = fromRect
    }
  }, [imageId, playOpenFlip])

  useEffect(() => {
    return () => {
      closeCancelRef.current?.()
      if (closeFallbackTimerRef.current != null) {
        window.clearTimeout(closeFallbackTimerRef.current)
      }
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }
  }, [])

  // 优雅关闭：在真实浏览器且未开启减少动态效果时，收回至原缩略图坐标或沿抛掷方向柔和退场；
  // jsdom / 无布局环境 / reduced-motion 下同步关闭，保证测试和无障碍零延迟。
  const requestClose = useCallback(
    (flingDirection = 0) => {
      if (closingRef.current) return
      const shell = mediaShellRef.current
      const backdrop = backdropRef.current
      const chrome = chromeRef.current
      if (prefersReducedMotion() || !shell || typeof shell.animate !== 'function') {
        onClose()
        return
      }

      const d = dismissRef.current
      const startDx = d.dx
      const startDy = d.dy
      const startScale = d.active ? clamp(1 - Math.abs(startDy) / 1100, 0.78, 1) : 1

      // 先清掉 shell 上的下拉拖拽内联变换再量未变换时的自然中心，避免 WAAPI 与内联 transform 双重叠加。
      shell.style.transition = 'none'
      shell.style.transform = ''
      const toRect = shell.getBoundingClientRect()
      if (!toRect || toRect.width <= 8 || toRect.height <= 8) {
        onClose()
        return
      }

      closingRef.current = true
      d.active = false
      d.pending = false
      d.dx = 0
      d.dy = 0
      d.vy = 0

      const sourceRect = scaleRef.current <= 1 && imageId ? findSourceImageRect(imageId) : null

      let endTransform: string
      let endOpacity = 0
      let duration = FLIP_CLOSE_MS
      let easing = FLIP_CLOSE_EASING

      if (sourceRect) {
        const dx = sourceRect.left + sourceRect.width / 2 - (toRect.left + toRect.width / 2)
        const dy = sourceRect.top + sourceRect.height / 2 - (toRect.top + toRect.height / 2)
        const targetScale = clamp(
          Math.min(sourceRect.width / toRect.width, sourceRect.height / toRect.height),
          0.12,
          1,
        )
        endTransform = `translate3d(${dx}px, ${dy}px, 0) scale(${targetScale})`
        endOpacity = 0.25
      } else {
        const shiftY = flingDirection !== 0 ? startDy + flingDirection * 56 : startDy + 24
        endTransform = `translate3d(${startDx}px, ${shiftY}px, 0) scale(0.92)`
        duration = 170
        easing = 'cubic-bezier(0.4, 0, 1, 1)'
      }

      const readOpacity = (node: HTMLElement): number => {
        const parsed = Number.parseFloat(window.getComputedStyle(node).opacity)
        return Number.isFinite(parsed) ? parsed : 1
      }

      const anim = shell.animate(
        [
          {
            transform: `translate3d(${startDx}px, ${startDy}px, 0) scale(${startScale})`,
            opacity: 1,
          },
          { transform: endTransform, opacity: endOpacity },
        ],
        { duration, easing, fill: 'forwards' },
      )
      const backdropAnim =
        backdrop && typeof backdrop.animate === 'function'
          ? backdrop.animate([{ opacity: readOpacity(backdrop) }, { opacity: 0 }], {
              duration,
              easing,
              fill: 'forwards',
            })
          : null
      const chromeAnim =
        chrome && typeof chrome.animate === 'function'
          ? chrome.animate([{ opacity: readOpacity(chrome) }, { opacity: 0 }], {
              duration: Math.min(duration, 140),
              easing,
              fill: 'forwards',
            })
          : null

      let settled = false
      const clearPendingClose = () => {
        anim.onfinish = null
        anim.oncancel = null
        if (closeFallbackTimerRef.current != null) {
          window.clearTimeout(closeFallbackTimerRef.current)
          closeFallbackTimerRef.current = null
        }
        closeCancelRef.current = null
      }
      const finish = () => {
        if (settled) return
        settled = true
        clearPendingClose()
        onClose()
      }
      closeCancelRef.current = () => {
        if (settled) return
        settled = true
        clearPendingClose()
        anim.cancel()
        backdropAnim?.cancel()
        chromeAnim?.cancel()
        closingRef.current = false
      }
      anim.onfinish = finish
      anim.oncancel = finish
      closeFallbackTimerRef.current = window.setTimeout(finish, duration + 60)
    },
    [imageId, onClose],
  )

  // 切换图片时取消未完成的关闭动画并重置缩放与拖拽关闭偏移（同一 imageId 从缩略图升级为原图时保留状态）
  const zoomIdentity = imageId || src
  useEffect(() => {
    void zoomIdentity
    closeCancelRef.current?.()
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    dismissRef.current = {
      active: false,
      pending: false,
      startX: 0,
      startY: 0,
      lastY: 0,
      lastTime: 0,
      vy: 0,
      dx: 0,
      dy: 0,
    }
    rerender()
  }, [zoomIdentity, rerender])

  useEffect(() => {
    const suppressClick = () => {
      suppressNextClickRef.current = true
    }

    window.addEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
    return () =>
      window.removeEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
  }, [])

  const getCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { cx: 0, cy: 0 }
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }, [])

  const apply = useCallback(
    (s: number, tx: number, ty: number) => {
      const ns = clamp(s, MIN_SCALE, MAX_SCALE)
      scaleRef.current = ns
      txRef.current = ns <= 1 ? 0 : tx
      tyRef.current = ns <= 1 ? 0 : ty

      // 显示缩放倍率并重置自动隐藏计时器
      if (ns > 1) {
        setShowZoomBadge(true)
        if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
        zoomTimerRef.current = setTimeout(() => setShowZoomBadge(false), 1500)
      } else {
        setShowZoomBadge(false)
        if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      }

      rerender()
    },
    [rerender],
  )

  // ====== 滚轮缩放 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scaleRef.current
      const tx = txRef.current
      const ty = tyRef.current
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const r = ns / s
      apply(ns, mx - r * (mx - tx), my - r * (my - ty))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply])

  // ====== 鼠标拖拽（放大平移 / 未缩放下拉关闭） + 点击关闭 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (e.target instanceof Element && e.target.closest('button')) return
      didDragRef.current = false
      if (scaleRef.current <= 1) {
        dismissRef.current = {
          active: false,
          pending: true,
          startX: e.clientX,
          startY: e.clientY,
          lastY: e.clientY,
          lastTime: performance.now(),
          vy: 0,
          dx: 0,
          dy: 0,
        }
        return
      }
      e.preventDefault()
      dragRef.current = {
        active: true,
        pending: false,
        startX: e.clientX,
        startY: e.clientY,
        baseTx: txRef.current,
        baseTy: tyRef.current,
      }
    }

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (d.active) {
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
        apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
        return
      }
      const dm = dismissRef.current
      if (!dm.active && !dm.pending) return
      const rawDx = e.clientX - dm.startX
      const rawDy = e.clientY - dm.startY
      if (dm.pending) {
        if (Math.hypot(rawDx, rawDy) < TOUCH_DRAG_THRESHOLD_PX) return
        if (Math.abs(rawDy) >= Math.abs(rawDx) * 1.1) {
          dm.active = true
          dm.pending = false
          didDragRef.current = true
        } else {
          dm.pending = false
          return
        }
      }
      const now = performance.now()
      const dt = Math.max(1, now - dm.lastTime)
      dm.vy = (e.clientY - dm.lastY) / dt
      dm.lastY = e.clientY
      dm.lastTime = now
      dm.dx = rawDx * 0.35
      dm.dy = rawDy
      rerender()
    }

    const onUp = () => {
      dragRef.current.active = false
      const dm = dismissRef.current
      if (dm.active) {
        const effectiveVy = performance.now() - dm.lastTime <= VELOCITY_STALE_MS ? dm.vy : 0
        const shouldClose =
          Math.abs(dm.dy) >= DISMISS_DISTANCE_PX || Math.abs(effectiveVy) >= DISMISS_VELOCITY_PX_MS
        if (shouldClose) {
          requestClose(dm.dy >= 0 ? 1 : -1)
        } else {
          dm.active = false
          dm.pending = false
          dm.dx = 0
          dm.dy = 0
          dm.vy = 0
          rerender()
        }
      } else {
        dm.pending = false
      }
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply, rerender, requestClose])

  // ====== 单击关闭（仅未缩放且非拖拽） ======
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        e.stopPropagation()
        return
      }
      if (didDragRef.current) {
        didDragRef.current = false
        return
      }
      if (scaleRef.current > 1 && e.target instanceof HTMLImageElement) return
      requestClose()
    },
    [requestClose],
  )

  // ====== 鼠标双击缩放 ======
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (scaleRef.current > 1) {
        apply(1, 0, 0)
      } else {
        const { cx, cy } = getCenter()
        const mx = e.clientX - cx
        const my = e.clientY - cy
        apply(3, -mx * 2, -my * 2)
      }
    },
    [apply, getCenter],
  )

  const handleSave = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      // 还在读原图时存下去只会得到一张缩略图，宁可让用户再等一下。
      if (originalUnavailable) {
        showToast(t(originalFailed ? 'lightbox.originalFailed' : 'lightbox.loadingOriginal'))
        return
      }
      try {
        const blob = await (await fetch(src)).blob()
        const filename = `image-${Date.now()}.${blob.type.split('/')[1] || 'png'}`
        if ('download' in document.createElement('a')) {
          downloadBlob(blob, filename)
          showToast(t('download.start'), 'success')
        } else {
          // iOS 13 之前忽略 download 属性，只能把图打开让用户长按保存
          window.open(URL.createObjectURL(blob), '_blank')
        }
      } catch (err) {
        console.error(err)
        showToast(t('lightbox.saveFailed'), 'error')
      }
    },
    [originalUnavailable, originalFailed, src, showToast, t],
  )

  // ====== 触控事件 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      // 工具栏按钮上的触摸不参与手势，否则 touchend 会把它当成「点击空白关闭」
      if (e.target instanceof Element && e.target.closest('button')) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }
      if (e.touches.length === 2) {
        e.preventDefault()
        hadMultiTouchRef.current = true
        tapRef.current = { time: 0, x: 0, y: 0 }
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const { cx, cy } = getCenter()
        pinchRef.current = {
          active: true,
          startDist: dist,
          startScale: scaleRef.current,
          startTx: txRef.current,
          startTy: tyRef.current,
          midX: (a.clientX + b.clientX) / 2 - cx,
          midY: (a.clientY + b.clientY) / 2 - cy,
        }
        dragRef.current.active = false
        const hadDismissOffset =
          dismissRef.current.active || dismissRef.current.dx !== 0 || dismissRef.current.dy !== 0
        dismissRef.current.active = false
        dismissRef.current.pending = false
        dismissRef.current.dx = 0
        dismissRef.current.dy = 0
        dismissRef.current.vy = 0
        if (hadDismissOffset) rerender()
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        const now = Date.now()
        const prev = tapRef.current
        touchStartedOnImageRef.current = e.target instanceof HTMLImageElement

        // 双击检测
        if (
          now - prev.time < 300 &&
          Math.abs(t.clientX - prev.x) < 30 &&
          Math.abs(t.clientY - prev.y) < 30
        ) {
          e.preventDefault()
          if (scaleRef.current > 1) {
            apply(1, 0, 0)
          } else {
            const { cx, cy } = getCenter()
            const mx = t.clientX - cx
            const my = t.clientY - cy
            apply(3, -mx * 2, -my * 2)
          }
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        tapRef.current = { time: now, x: t.clientX, y: t.clientY }

        // 这里不 preventDefault：iOS 一旦取消 touchstart 就不再弹长按保存菜单。
        // 拖动改到 touchmove 超过阈值时才拦。
        if (scaleRef.current > 1 && touchStartedOnImageRef.current) {
          dragRef.current = {
            active: false,
            pending: true,
            startX: t.clientX,
            startY: t.clientY,
            baseTx: txRef.current,
            baseTy: tyRef.current,
          }
        } else if (scaleRef.current <= 1) {
          dismissRef.current = {
            active: false,
            pending: true,
            startX: t.clientX,
            startY: t.clientY,
            lastY: t.clientY,
            lastTime: performance.now(),
            vy: 0,
            dx: 0,
            dy: 0,
          }
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pinchRef.current.active && e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const p = pinchRef.current
        const ns = clamp(p.startScale * (dist / p.startDist), MIN_SCALE, MAX_SCALE)
        const r = ns / p.startScale
        apply(ns, p.midX - r * (p.midX - p.startTx), p.midY - r * (p.midY - p.startTy))
      } else if ((dragRef.current.active || dragRef.current.pending) && e.touches.length === 1) {
        const t = e.touches[0]
        const d = dragRef.current
        if (!d.active) {
          if (Math.hypot(t.clientX - d.startX, t.clientY - d.startY) < TOUCH_DRAG_THRESHOLD_PX) {
            return
          }
          d.active = true
          d.pending = false
        }
        e.preventDefault()
        apply(scaleRef.current, d.baseTx + t.clientX - d.startX, d.baseTy + t.clientY - d.startY)
      } else if (
        (dismissRef.current.active || dismissRef.current.pending) &&
        e.touches.length === 1
      ) {
        const t = e.touches[0]
        const dm = dismissRef.current
        const rawDx = t.clientX - dm.startX
        const rawDy = t.clientY - dm.startY
        if (dm.pending) {
          if (Math.hypot(rawDx, rawDy) < TOUCH_DRAG_THRESHOLD_PX) return
          if (Math.abs(rawDy) >= Math.abs(rawDx) * 1.1) {
            dm.active = true
            dm.pending = false
            tapRef.current = { time: 0, x: 0, y: 0 }
          } else {
            dm.pending = false
            return
          }
        }
        e.preventDefault()
        const now = performance.now()
        const dt = Math.max(1, now - dm.lastTime)
        dm.vy = (t.clientY - dm.lastY) / dt
        dm.lastY = t.clientY
        dm.lastTime = now
        dm.dx = rawDx * 0.35
        dm.dy = rawDy
        rerender()
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false
        dragRef.current.pending = false
        const dm = dismissRef.current
        if (dm.active) {
          const effectiveVy = performance.now() - dm.lastTime <= VELOCITY_STALE_MS ? dm.vy : 0
          const shouldClose =
            Math.abs(dm.dy) >= DISMISS_DISTANCE_PX ||
            Math.abs(effectiveVy) >= DISMISS_VELOCITY_PX_MS
          if (shouldClose) {
            requestClose(dm.dy >= 0 ? 1 : -1)
          } else {
            dm.active = false
            dm.pending = false
            dm.dx = 0
            dm.dy = 0
            dm.vy = 0
            rerender()
          }
          return
        }
        dm.pending = false
        if (hadMultiTouchRef.current) {
          hadMultiTouchRef.current = false
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        // 单击关闭：未缩放时任意位置关闭；缩放时仅点击图片外关闭。
        if (scaleRef.current <= 1 || !touchStartedOnImageRef.current) {
          const prev = tapRef.current
          if (prev.time > 0 && Date.now() - prev.time < 300) {
            setTimeout(() => {
              if (tapRef.current.time === prev.time) {
                requestClose()
              }
            }, 310)
          }
        }
      }
    }

    // iOS 弹出长按菜单时发 touchcancel 而不是 touchend，不清掉手势状态下一次触摸会从旧起点跳一下
    const onTouchCancel = () => {
      dragRef.current.active = false
      dragRef.current.pending = false
      pinchRef.current.active = false
      if (dismissRef.current.active || dismissRef.current.dy !== 0) {
        dismissRef.current.active = false
        dismissRef.current.pending = false
        dismissRef.current.dx = 0
        dismissRef.current.dy = 0
        dismissRef.current.vy = 0
        rerender()
      } else {
        dismissRef.current.pending = false
      }
      tapRef.current = { time: 0, x: 0, y: 0 }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [apply, getCenter, rerender, requestClose])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const dismiss = dismissRef.current
  const isDismissDragging = dismiss.active
  const dismissScale = isDismissDragging ? clamp(1 - Math.abs(dismiss.dy) / 1100, 0.78, 1) : 1
  const backdropOpacity = isDismissDragging ? clamp(1 - Math.abs(dismiss.dy) / 360, 0.15, 1) : 1
  const chromeOpacity = isDismissDragging ? clamp(1 - Math.abs(dismiss.dy) / 120, 0, 1) : 1
  const isZoomed = s > 1
  const isPanDragging = dragRef.current.active || pinchRef.current.active
  const isDragging = isPanDragging || isDismissDragging
  const zoomPercent = Math.round(s * 100)
  const shellDismissTransform =
    !isZoomed && (isDismissDragging || dismiss.dx !== 0 || dismiss.dy !== 0)
      ? `translate3d(${dismiss.dx}px, ${dismiss.dy}px, 0) scale(${dismissScale})`
      : undefined

  const navBtnClass = 'absolute top-1/2 -translate-y-1/2 z-10'

  return (
    <Overlay
      onClose={requestClose}
      tier={tier}
      backdrop="none"
      layout="fill"
      label={t('lightbox.dialog')}
    >
      <div
        ref={containerRef}
        data-lightbox-root
        className="flex h-full w-full items-center justify-center select-none"
        style={{
          cursor: isZoomed
            ? isDragging
              ? 'grabbing'
              : 'grab'
            : isDismissDragging
              ? 'grabbing'
              : 'pointer',
        }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div
          ref={backdropRef}
          className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in"
          style={{
            opacity: backdropOpacity,
            transition: isDismissDragging ? 'none' : 'opacity var(--motion-normal) var(--ease-out)',
          }}
        />
        <div
          ref={mediaShellRef}
          data-lightbox-media-shell
          className={`relative ${usedSharedOpenFlip ? '' : 'animate-zoom-in'}`}
          style={{
            transform: shellDismissTransform,
            transition: isDismissDragging
              ? 'none'
              : 'transform var(--motion-normal) var(--ease-out)',
          }}
        >
          <div
            className="relative flex items-center justify-center"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${s})`,
              transition: isPanDragging ? 'none' : 'transform var(--motion-normal) var(--ease-out)',
              willChange: 'transform',
            }}
          >
            <img
              key={imageId || src}
              src={src}
              data-image-id={imageId}
              data-image-preview-only={originalUnavailable || undefined}
              className={`${originalUnavailable ? '' : 'saveable-image '}animate-fade-in max-w-[85vw] max-h-[85vh] object-contain rounded-lg shadow-2xl`}
              onLoad={() => {
                const pending = pendingOpenFlipRectRef.current
                if (pending && !didOpenFlipRef.current && playOpenFlip(pending)) {
                  didOpenFlipRef.current = true
                  pendingOpenFlipRectRef.current = null
                  setUsedSharedOpenFlip(true)
                }
              }}
              onDragStart={(e) => e.preventDefault()}
              alt=""
            />
            {maskPreviewSrc && (
              <img
                src={maskPreviewSrc}
                className="absolute inset-0 w-full h-full object-contain rounded-lg pointer-events-none"
                alt=""
              />
            )}
          </div>
        </div>
        {originalUnavailable && (
          <span
            className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs text-white backdrop-blur-sm"
            aria-live="polite"
          >
            {originalPending && <Icon name="loading" size="xs" className="animate-spin" />}
            {t(originalFailed ? 'lightbox.originalFailed' : 'lightbox.loadingOriginal')}
            {originalFailed && onRetryOriginal && (
              <Button
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation()
                  onRetryOriginal()
                }}
              >
                {t('common:action.retry')}
              </Button>
            )}
          </span>
        )}

        <div
          ref={chromeRef}
          className="absolute top-4 right-4 left-4 z-10 flex flex-wrap items-center justify-end gap-2"
          style={{
            opacity: chromeOpacity,
            transition: isDismissDragging ? 'none' : 'opacity var(--motion-fast) var(--ease-out)',
          }}
        >
          <Button
            data-save-image
            variant="secondary"
            disabled={originalUnavailable}
            onClick={handleSave}
            size="sm"
          >
            <Icon name="download" />
            {t('toolbox:export.downloadOriginal')}
          </Button>
          <Button
            size="sm"
            disabled={originalUnavailable}
            onClick={(event) => {
              event.stopPropagation()
              openImageExport([
                {
                  id: imageId || src,
                  name: 'image',
                  media: 'image',
                  load: (signal) => originalBlob(src, signal),
                },
              ])
            }}
          >
            <Icon name="download" />
            {t('toolbox:export.export')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={t('common:action.close')}
            onClick={(event) => {
              event.stopPropagation()
              requestClose()
            }}
          >
            <Icon name="close" />
          </Button>
        </div>

        {/* 左右切换按钮 */}
        {showNav && !isZoomed && (
          <>
            <Button
              type="button"
              aria-label={t('common:action.previousImage')}
              variant="secondary"
              size="icon"
              className={`${navBtnClass} left-3 sm:left-5`}
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
            >
              <Icon name="chevronLeft" />
            </Button>
            <Button
              type="button"
              aria-label={t('common:action.nextImage')}
              variant="secondary"
              size="icon"
              className={`${navBtnClass} right-3 sm:right-5`}
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
            >
              <Icon name="chevronRight" />
            </Button>
          </>
        )}

        {/* 底部指示器 */}
        {showZoomBadge && isZoomed && zoomPercent !== 100 && (
          <div className="animate-fade-in absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
            <span className="px-3 py-1.5 bg-black/55 text-white text-xs rounded-full backdrop-blur-sm tabular-nums">
              {zoomPercent}%
            </span>
          </div>
        )}
        {showNav && !isZoomed && (
          <div className="animate-fade-in absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
            <span className="px-3 py-1.5 bg-black/55 text-white text-xs rounded-full backdrop-blur-sm tabular-nums">
              {currentIndex + 1} / {total}
            </span>
          </div>
        )}
      </div>
    </Overlay>
  )

  function goPrev() {
    onPrev()
  }
  function goNext() {
    onNext()
  }
}
