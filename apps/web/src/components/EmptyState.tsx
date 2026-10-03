import type { ReactNode } from 'react'

/** 空态：一枚线性图标 + 一句说明 + 可选一个动作，放在内容区上部居中。 */
export default function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-muted-foreground">
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-muted text-muted-foreground [&_svg]:h-5 [&_svg]:w-5"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-body-sm text-foreground">{title}</p>
      {description ? <p className="text-label-sm">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
