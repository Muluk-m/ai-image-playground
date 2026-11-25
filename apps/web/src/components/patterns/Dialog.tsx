import { type ReactNode, useId } from 'react'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import Overlay, { type OverlayTier } from './Overlay'

/**
 * 标准对话框：Overlay 外壳 + 面板（标题、右上角关闭、可滚动正文、可选底栏）。
 * 面板宽度用 className 的 max-w-* 给；确认类对话框走全局 setConfirmDialog，不用它。
 */
export interface DialogSurfaceProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** 底栏按钮：左侧次要操作，右侧「取消」(outline) +「确认」(default) */
  footer?: ReactNode
  className?: string
  /** 提交或处理中时禁止通过右上角、遮罩或 Esc 关闭对话框。 */
  closeDisabled?: boolean
}

/** 已由宿主管理浮层时复用面板；不创建 portal，也不重复接管焦点。 */
export function DialogSurface({
  title,
  onClose,
  children,
  footer,
  className,
  closeDisabled = false,
}: DialogSurfaceProps) {
  const { t } = useTranslation('common')
  const titleId = useId()
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={cn(
        'animate-modal-in flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-card shadow-dialog ring-1 ring-hairline',
        className,
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 pb-2 pl-6 pr-3 pt-4">
        <h2 id={titleId} className="min-w-0 truncate text-xl font-semibold text-foreground">
          {title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={closeDisabled}
          aria-label={t('action.close')}
          // 图标按钮保持 32px，伪元素把可点区域扩到 44×44。
          className="relative text-muted-foreground after:absolute after:-inset-1.5 after:content-['']"
          onClick={() => {
            if (!closeDisabled) onClose()
          }}
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-2">
        {children}
      </div>
      {footer && (
        <div
          data-slot="dialog-footer"
          className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3"
        >
          {footer}
        </div>
      )}
    </div>
  )
}

export default function Dialog({ tier, ...props }: DialogSurfaceProps & { tier?: OverlayTier }) {
  return (
    <Overlay onClose={props.closeDisabled ? () => {} : props.onClose} tier={tier} role="none">
      <DialogSurface {...props} />
    </Overlay>
  )
}
