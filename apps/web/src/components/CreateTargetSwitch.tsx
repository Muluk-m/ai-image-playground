import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { useStore } from '../store'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

/** 首屏的三条创作路径：对话、直出与画布各有独立入口，对话排在最前。 */
export default function CreateTargetSwitch() {
  const { t } = useTranslation('shell')
  const target = useStore((s) => s.createTarget)
  const setTarget = useStore((s) => s.setCreateTarget)
  const agentEnabled = isClientCapabilityEnabled('agent:chat')
  const options = [
    ...(agentEnabled
      ? [
          {
            id: 'chat' as const,
            label: t('createTarget.chat'),
            icon: <Icon name="chat" />,
          },
        ]
      : []),
    {
      id: 'generate',
      label: t('createTarget.generate'),
      icon: <Icon name="generate" />,
    },
    {
      id: 'canvas',
      label: agentEnabled ? t('createTarget.canvas') : t('mode.canvas'),
      icon: <Icon name="canvas" />,
    },
  ] as const
  return (
    <div
      role="tablist"
      aria-label={t('createTarget.aria')}
      className="studio-create-target mx-auto flex w-fit max-w-full rounded-full border border-border bg-card/70 p-1 backdrop-blur"
    >
      {options.map((one) => {
        const active = one.id === target || (one.id === 'generate' && target === 'video')
        return (
          <Button
            variant="ghost"
            size="default"
            key={one.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setTarget(one.id)}
            className={`max-md:h-11 min-w-0 gap-1.5 rounded-full px-3 text-xs sm:min-w-[7.5rem] sm:gap-2 sm:px-5 sm:text-sm ${
              active
                ? 'studio-create-target-active'
                : 'text-muted-foreground hover:bg-transparent hover:text-foreground'
            }`}
          >
            {one.icon}
            {one.label}
          </Button>
        )
      })}
    </div>
  )
}
