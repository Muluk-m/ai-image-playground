import * as React from 'react'
import { cn } from '../lib/utils'
import { Checkbox as CheckboxRoot } from './ui/checkbox'
import { Label } from './ui/label'

type RootProps = React.ComponentPropsWithoutRef<typeof CheckboxRoot>

export interface CheckboxProps extends Omit<RootProps, 'checked' | 'onCheckedChange' | 'onChange'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  tone?: 'primary' | 'danger'
}

const DANGER =
  'border-destructive/60 focus-visible:ring-destructive data-[state=checked]:border-destructive data-[state=checked]:bg-destructive data-[state=checked]:text-destructive-foreground'

/**
 * 勾选框加它的标签。shadcn 的原语只管那个方框，点击区、间距和标签在这里组合，
 * 免得每个调用点自己拼一遍——拼出来的正是 2026-09 被作用域 CSS 压散的那种结构。
 */
export function Checkbox({
  checked,
  onChange,
  label,
  tone = 'primary',
  className,
  id,
  ...props
}: CheckboxProps) {
  const generatedId = React.useId()
  const controlId = id ?? generatedId

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <CheckboxRoot
        id={controlId}
        checked={checked}
        onCheckedChange={(state) => onChange(state === true)}
        className={tone === 'danger' ? DANGER : undefined}
        {...props}
      />
      {label && (
        <Label htmlFor={controlId} className="cursor-pointer text-[13px] text-foreground">
          {label}
        </Label>
      )}
    </div>
  )
}
