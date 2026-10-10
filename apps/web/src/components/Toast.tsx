import { useStore } from '../store'

export default function Toast() {
  const toast = useStore((s) => s.toast)

  const getIcon = (type: NonNullable<typeof toast>['type']) => {
    switch (type) {
      case 'success':
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-success/10 dark:bg-success/50 text-success dark:text-success">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-destructive/10 dark:bg-destructive/50 text-destructive dark:text-destructive">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
        )
      default:
        return (
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        )
    }
  }

  // live region 必须常驻：节点和文字同时出现时读屏常常不播报，所以只切换里面的内容。
  // 放在页头下方：底部会压住输入框和它向下展开的生成设置弹层。
  return (
    <div
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
