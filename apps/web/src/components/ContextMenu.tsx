import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

interface ContextMenuProps {
  x: number
  y: number
  onClose: () => void
  /** 关闭前先看一眼落点，给调用方处理自己的副作用。 */
  onOutsidePointer?: (target: EventTarget | null) => void
  children: ReactNode
}

const MARGIN = 4

/**
 * 右键 / 长按菜单的外壳：portal 到 body，按实测尺寸夹回视口，点外面 / 滚动 / 缩放即关。
 * 定位型浮层，不走 Overlay。
 */
export default function ContextMenu({
  x,
  y,
  onClose,
  onOutsidePointer,
  children,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - rect.height - MARGIN)),
    })
  }, [x, y])

  useEffect(() => {
    const close = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      onOutsidePointer?.(e.target)
      onClose()
    }
    const options = { capture: true } as const
    window.addEventListener('mousedown', close, options)
    window.addEventListener('touchstart', close, options)
    window.addEventListener('wheel', close, options)
    window.addEventListener('scroll', close, options)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close, options)
      window.removeEventListener('touchstart', close, options)
      window.removeEventListener('wheel', close, options)
      window.removeEventListener('scroll', close, options)
      window.removeEventListener('resize', close)
    }
  }, [onClose, onOutsidePointer])

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[120px] overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-xl animate-fade-in dark:border-gray-700 dark:bg-gray-800"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  )
}

export function ContextMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: (e: ReactMouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
    >
      {icon}
      {label}
    </button>
  )
}
