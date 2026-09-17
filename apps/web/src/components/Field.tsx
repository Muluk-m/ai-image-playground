import type * as React from 'react'
import { cn } from '../lib/utils'
import { Label } from './ui/label'

/**
 * 一个标签配一个控件。标签把控件裹在里面，点标签就能聚焦控件，不用为此维护一串 id。
 * 导演台原来靠 `label { display: grid }` 这条作用域样式拿到同样的排版，代价是容器里
 * 每个 label 都被一起改写；这里把那份意图收进一个组件。
 */
export default function Field({
  label,
  className,
  children,
}: {
  label: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Label className={cn('grid gap-[7px] text-xs font-normal text-muted-foreground', className)}>
      {label}
      {children}
    </Label>
  )
}
