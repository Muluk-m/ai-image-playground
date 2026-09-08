import type { ButtonHTMLAttributes, ReactNode } from 'react'
import ViewportTooltip from '../../../components/ViewportTooltip'
import { useTooltip } from '../../../hooks/useTooltip'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  /** 无障碍名与提示文案共用一份，不要另写 title：原生提示会和这个提示叠着出。 */
  label: string
  children: ReactNode
}

/** 图标按钮：悬停、聚焦即出应用自己的提示，与顶栏同款。 */
export default function IconButton({ label, children, onClick, ...props }: IconButtonProps) {
  const tooltip = useTooltip()

  return (
    <button
      type="button"
      {...props}
      {...tooltip.handlers}
      onClick={(event) => {
        onClick?.(event)
        tooltip.handlers.onClick()
      }}
      aria-label={label}
    >
      {children}
      <ViewportTooltip visible={tooltip.visible} className="whitespace-nowrap">
        {label}
      </ViewportTooltip>
    </button>
  )
}
