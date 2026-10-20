import { useLayoutEffect, useRef } from 'react'
import { useStore } from '../store'
import { Icon } from './ui/icon'

export default function Toast() {
  const toast = useStore((s) => s.toast)
  const appMode = useStore((s) => s.appMode)
  const hostRef = useRef<HTMLDivElement>(null)

  const getIcon = (type: NonNullable<typeof toast>['type']) => {
    switch (type) {
      case 'success':
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-success/10 dark:bg-success/50 text-success dark:text-success">
            <Icon name="success" size="xs" />
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-destructive/10 dark:bg-destructive/50 text-destructive dark:text-destructive">
            <Icon name="error" size="xs" />
          </div>
        )
      default:
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary">
            <Icon name="info" size="xs" />
          </div>
        )
    }
  }

  // live region 必须常驻：节点和文字同时出现时读屏常常不播报，所以只切换里面的内容。
  // 默认贴在页头下方：再往下会压住输入框和它向下展开的生成设置。创作页的大标题也占着
  // 这一截，出现问候语时改放到问候语下面那条空档里，避免盖住标题。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const place = () => {
      const intro = document.querySelector('.studio-home-intro')
      if (!intro) {
        host.style.top = ''
        return
      }
      const bottom = intro.getBoundingClientRect().bottom
      host.style.top = `${Math.ceil(bottom + 12)}px`
    }
    place()
    const intro = document.querySelector('.studio-home-intro')
    const observer = intro ? new ResizeObserver(place) : null
    observer?.observe(intro)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      host.style.top = ''
    }
  }, [toast, appMode])

  return (
    <div
      ref={hostRef}
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-16 z-[1400] pointer-events-none"
    >
      {toast && (
        <div
          key={toast.message}
          className="toast-enter flex items-center gap-2.5 w-max max-w-[calc(100vw-32px)] sm:max-w-[min(28rem,60vw)] px-5 py-3.5 bg-card/95 backdrop-blur-xl border border-border/60 rounded-full shadow-popover ring-1 ring-hairline text-sm font-medium text-foreground"
        >
          <span className="flex-shrink-0" aria-hidden="true">
            {getIcon(toast.type)}
          </span>
          <span className="leading-5 whitespace-pre-line text-center">{toast.message}</span>
        </div>
      )}
    </div>
  )
}
