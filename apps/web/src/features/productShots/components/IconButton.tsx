import type { ButtonHTMLAttributes, ReactNode } from 'react'
import ViewportTooltip from '../../../components/ViewportTooltip'
import { useTooltip } from '../../../hooks/useTooltip'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string
  children: ReactNode
}

/** label 同时当无障碍名与即时提示；别再补 title，原生提示会和它叠着出。 */
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
