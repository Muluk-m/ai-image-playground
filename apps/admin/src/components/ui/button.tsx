import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../../lib/utils'
import { Hint } from './tooltip'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
        // 28 / 32 / 40 档见 apps/web/DESIGN.md「控件高度」：页签与小按钮 28，图标按钮 32，首页输入框工具 40。
        xs: 'h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5',
        'icon-sm': 'size-8',
        'icon-xs': 'size-7 [&_svg]:size-3.5',
        'icon-lg': 'size-10 [&_svg]:size-5',
        'chip-lg':
          'h-10 rounded-xl px-3 text-xs [@container_creation-composer_(max-width:520px)]:h-8 [@container_creation-composer_(max-width:520px)]:rounded-lg [@container_creation-composer_(max-width:520px)]:px-2 [@container_creation-composer_(max-width:520px)]:text-label-sm',
        'chip-sm': 'h-8 rounded-lg px-2.5 text-label-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  'data-tooltip-trigger'?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, title, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const hasTooltip = props['data-tooltip-trigger']
    const label = title || props['aria-label']
    const button = (
      <Comp
        className={cn(
          buttonVariants({ variant, size, className }),
          label && !asChild && 'disabled:pointer-events-auto',
        )}
        ref={ref}
        aria-description={title}
        {...props}
      />
    )
    // 已有 Hint 的组合件沿用它自己的文案，避免双重提示。Portal 不改变按钮的布局层级。
    return label && !hasTooltip ? <Hint tooltip={label}>{button}</Hint> : button
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
