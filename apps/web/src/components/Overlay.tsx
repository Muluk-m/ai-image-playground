import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { dismissAllTooltips } from '../lib/tooltipDismiss'

/**
 * Overlay — 所有模态浮层的唯一外壳。拥有六条纪律：
 *
 * 1. portal 到 document.body —— 不受祖先 transform/filter/backdrop-filter 包含块影响
 * 2. scroll-lock —— usePreventBackgroundScroll，内容自动作为滚动边界（display:contents 包裹，
 *    只提供 DOM 包含关系，不产生布局盒）；边界对所有打开中的 Overlay 共享，见 openBoundaries
 * 3. ESC 栈 —— useCloseOnEscape，一次只关最顶层
 * 4. backdrop 关闭 —— pointerdown-guard：pointerdown 必须落在表面上，click 才关闭（防划词误关）；
 *    backdrop 必须 pointer-events-none，否则它盖在表面之上、命中的是 backdrop 而非表面，永不关闭
 * 5. z 层三档 —— modal(50) / raised(100) / alert(110)
 * 6. 打开任意 Overlay 时统一收起 Tooltip —— 定位型浮层不得越过模态 backdrop
 *
 * 定位型浮层（Tooltip、Select 下拉、拖拽预览）不属于这里。
 */
const TIER_CLASS = {
  modal: 'z-50',
  raised: 'z-[100]',
  alert: 'z-[110]',
} as const

type OverlayTier = keyof typeof TIER_CLASS

/**
 * 所有打开中的 Overlay 的滚动边界。嵌套浮层时，子浮层是 body 下的兄弟 portal，不在父浮层的
 * 边界内；每层都装了 document 级 wheel guard，只认自己的边界就会把子浮层的滚动 preventDefault 掉。
 * 故边界共享：落在任意一层内容里的滚动都放行，背景页仍由 body overflow:hidden 锁住。
 * 模块级常量身份稳定，hook 的 effect 不会因它重新注册。
 */
const openBoundaries: Array<RefObject<HTMLDivElement | null>> = []

interface OverlayProps {
  onClose: () => void
  tier?: OverlayTier
  /** dim = 标准暗化 backdrop；none = 无 backdrop（全屏模态 / 自有表面的 Lightbox） */
  backdrop?: 'dim' | 'none'
  /** center = 居中 + p-4（默认）；fill = 内容自己撑满视口 */
  layout?: 'center' | 'fill'
  children: ReactNode
}

export default function Overlay({
  onClose,
  tier = 'modal',
  backdrop = 'dim',
  layout = 'center',
  children,
}: OverlayProps) {
  const boundaryRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dismissAllTooltips()
    openBoundaries.push(boundaryRef)
    return () => {
      openBoundaries.splice(openBoundaries.indexOf(boundaryRef), 1)
    }
  }, [])
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, openBoundaries)

  // pointerdown-guard：只有 press 起点落在表面本身（非内容），click 才触发关闭
  const surfaceDownRef = useRef(false)

  const surfaceClass =
    `fixed inset-0 ${TIER_CLASS[tier]}` +
    (layout === 'center' ? ' flex items-center justify-center p-4' : '')

  return createPortal(
    <div
      data-no-drag-select
      className={surfaceClass}
      onPointerDown={(e) => {
        surfaceDownRef.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (surfaceDownRef.current && e.target === e.currentTarget) onClose()
      }}
    >
      {backdrop === 'dim' && (
        <div className="absolute inset-0 -z-10 bg-black/30 backdrop-blur-sm animate-overlay-in pointer-events-none" />
      )}
      <div ref={boundaryRef} className="contents">
        {children}
      </div>
    </div>,
    document.body,
  )
}
