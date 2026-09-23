import type { ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  icon?: ReactNode
  /** 内容容器的 class：成组的设置行用一张卡，危险动作自己带警示色。 */
  className?: string
  children: ReactNode
}

/** 设置页里的一段：一个小标题加它管的那几行。 */
export default function SettingsSection({
  title,
  icon,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon ? (
          <span className="shrink-0" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {title}
      </h4>
      <div className={className}>{children}</div>
    </section>
  )
}
