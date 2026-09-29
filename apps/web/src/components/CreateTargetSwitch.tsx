import { LayoutDashboard, MessageCircle } from 'lucide-react'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { useStore } from '../store'
import { SparkleIcon } from './icons'

/** 首屏的三条创作路径：直出、对话与画布各有独立入口。 */
export default function CreateTargetSwitch() {
  const { t } = useTranslation('shell')
  const target = useStore((s) => s.createTarget)
  const setTarget = useStore((s) => s.setCreateTarget)
  const agentEnabled = isClientCapabilityEnabled('agent:chat')
  const options = [
    {
      id: 'generate',
      label: t('createTarget.generate'),
      icon: <SparkleIcon className="h-4 w-4" />,
    },
    ...(agentEnabled
      ? [
          {
            id: 'chat' as const,
            label: t('createTarget.chat'),
            icon: <MessageCircle className="h-4 w-4" />,
          },
        ]
      : []),
    {
      id: 'canvas',
      label: agentEnabled ? t('createTarget.canvas') : t('mode.canvas'),
      icon: <LayoutDashboard className="h-4 w-4" />,
    },
  ] as const
  return (
    <div
      role="tablist"
      aria-label={t('createTarget.aria')}
      className="studio-create-target mx-auto flex w-fit max-w-full rounded-full border border-border bg-card/70 p-1 backdrop-blur"
    >
      {options.map((one) => {
        const active = one.id === target
        return (
          <button
            key={one.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setTarget(one.id)}
            className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors sm:min-w-[7.5rem] sm:gap-2 sm:px-5 sm:text-sm ${
              active ? 'studio-generate-button' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {one.icon}
            {one.label}
          </button>
        )
      })}
    </div>
  )
}
