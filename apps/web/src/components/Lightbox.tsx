import { useCallback, useEffect, useRef, useState } from 'react'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { downloadBlob } from '../lib/downloadImages'
import { ensureImageCached, getCachedImage, useStore } from '../store'
import { DownloadIcon } from './icons'
import Overlay from './Overlay'

const MIN_SCALE = 1
const MAX_SCALE = 10
/** 手指移出这个距离才算拖动 */
const TOUCH_DRAG_THRESHOLD_PX = 8

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export default function Lightbox() {
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const maskDraft = useStore((s) => s.maskDraft)
  const tasks = useStore((s) => s.tasks)

  const [src, setSrc] = useState('')
  const [maskImageSrc, setMaskImageSrc] = useState('')
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')

  const close = useCallback(() => setLightboxImageId(null), [setLightboxImageId])

  // 图片加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setSrc('')
      return
    }

    setSrc('')

    const imageId = lightboxImageId
    const cached = getCachedImage(imageId)
    if (cached) {
      setSrc(cached)
    } else {
      ensureImageCached(imageId).then((url) => {
        if (!cancelled && url) setSrc(url)
      })
    }

    return () => {
      cancelled = true
    }
  }, [lightboxImageId])

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
    if (taskWithMask?.maskImageId) {
      const maskImageId = taskWithMask.maskImageId
      const cached = getCachedImage(maskImageId)
      if (cached) {
        setMaskImageSrc(cached)
      } else {
        ensureImageCached(maskImageId).then((url) => {
          if (!cancelled && url) setMaskImageSrc(url)
        })
      }
    } else {
      setMaskImageSrc('')
    }

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

  if (!lightboxImageId || !src) return null

  return (
    <LightboxInner
      src={src}
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

interface LightboxInnerProps {
  src: string
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
  src,
  imageId,
  maskPreviewSrc,
  onClose,
  showNav,
  currentIndex,
  total,
  onPrev,
  onNext,
}: LightboxInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const showToast = useStore((s) => s.showToast)
  const [coarsePointer] = useState(() => window.matchMedia('(pointer: coarse)').matches)

  // 用 ref 追踪最新变换，避免闭包过期
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)

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

  // 切换图片时重置缩放
  useEffect(() => {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    rerender()
  }, [src, rerender])

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

  // ====== 鼠标拖拽 + 点击关闭 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      didDragRef.current = false
      if (scaleRef.current <= 1) return
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
      if (!d.active) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
      apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
    }

    const onUp = () => {
      dragRef.current.active = false
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply])

  // ====== 单击关闭（仅未缩放且非拖拽） ======
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        e.stopPropagation()
        return
      }
      if (didDragRef.current) return
      if (scaleRef.current > 1 && e.target instanceof HTMLImageElement) return
      onClose()
    },
    [onClose],
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
      try {
        const blob = await (await fetch(src)).blob()
        const filename = `image-${Date.now()}.${blob.type.split('/')[1] || 'png'}`
        if ('download' in document.createElement('a')) {
          downloadBlob(blob, filename)
          showToast('开始下载', 'success')
        } else {
          // iOS 13 之前忽略 download 属性，只能把图打开让用户长按保存
          window.open(URL.createObjectURL(blob), '_blank')
        }
      } catch (err) {
        console.error(err)
        showToast('保存失败', 'error')
      }
    },
    [src, showToast],
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
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false
        dragRef.current.pending = false
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
                onClose()
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
  }, [apply, getCenter, onClose])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const isZoomed = s > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const zoomPercent = Math.round(s * 100)

  const navBtnClass =
    'absolute top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-all z-10 backdrop-blur-sm'

  return (
    <Overlay onClose={onClose} tier="raised" backdrop="none" layout="fill">
      <div
        ref={containerRef}
        data-lightbox-root
        className="flex h-full w-full items-center justify-center select-none"
        style={{ cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'pointer' }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in" />
        <div className="relative animate-zoom-in">
          <div
            className="relative flex items-center justify-center"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${s})`,
              transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              willChange: 'transform',
            }}
          >
            <img
              src={src}
              data-image-id={imageId}
              className="saveable-image max-w-[85vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
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

        {coarsePointer && (
          <button
            data-save-image
            onClick={handleSave}
            className="absolute top-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-2 text-sm text-white backdrop-blur-sm transition-all hover:bg-black/60"
          >
            <DownloadIcon className="w-4 h-4" />
            保存图片
          </button>
        )}

        {/* 左右切换按钮 */}
        {showNav && !isZoomed && (
          <>
            <button
              className={`${navBtnClass} left-3 sm:left-5`}
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
            >
              <svg
                className="w-5 h-5 sm:w-6 sm:h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <button
              className={`${navBtnClass} right-3 sm:right-5`}
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
            >
              <svg
                className="w-5 h-5 sm:w-6 sm:h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </>
        )}

        {/* 底部指示器 */}
        {showZoomBadge && isZoomed && zoomPercent !== 100 && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
            <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm transition-opacity duration-500">
              {zoomPercent}%
            </span>
          </div>
        )}
        {showNav && !isZoomed && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
            <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm">
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
