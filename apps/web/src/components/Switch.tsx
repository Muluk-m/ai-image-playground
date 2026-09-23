import * as React from 'react'
import { cn } from '../lib/utils'

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role'> {
  checked: boolean
  onChange: (checked: boolean) => void
}

/**
 * 开关。项目里**唯一**一处 `role="switch"` 的实现——从前每个调用点自己拼一遍
 * 三十行的 button + 滑块模板，样式与可达性就各走各的。
 *
 * shadcn 上游的 switch 原语要 `@radix-ui/react-switch`，不为一个受控开关加依赖：
 * 这里按同一套 token 与尺寸写在组合层，调用点只给 `checked` / `onChange`。
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onChange, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  ),
)
Switch.displayName = 'Switch'
