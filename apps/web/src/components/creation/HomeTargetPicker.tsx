import { useTranslation } from '../../i18n'
import { isVideoModeAvailable } from '../../lib/channels/videoChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { useStore } from '../../store'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import { Icon, type IconName } from '../ui/icon'
import { useOverflowTitle } from '../ui/overflowTitle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import './creation.css'

type Target = 'chat' | 'generate' | 'video' | 'canvas'

const ICONS: Record<Target, IconName> = {
  chat: 'chat',
  generate: 'imageAdd',
  video: 'video',
  canvas: 'canvas',
}

/**
 * 首页输入框里的创作方式：对话、直出、视频和画布收进同一个下拉，
 * 切换只改去向，输入框里的提示词和参考图原样留着。
 */
export default function HomeTargetPicker() {
  const { t } = useTranslation(['composer', 'shell'])
  const target = useStore((s) => s.createTarget)
  const setTarget = useStore((s) => s.setCreateTarget)
  const agentEnabled = isClientCapabilityEnabled('agent:chat')
  const targets: Target[] = [
    ...(agentEnabled ? (['chat'] as const) : []),
    'generate',
    ...(isVideoModeAvailable() ? (['video'] as const) : []),
    'canvas',
  ]
  const labels: Record<Target, string> = {
    chat: t('shell:createTarget.chat'),
    generate: t('composer:studio.modes.image'),
    video: t('composer:studio.modes.video'),
    canvas: agentEnabled ? t('shell:createTarget.canvas') : t('shell:mode.canvas'),
  }
  const shortLabels: Record<Target, string> = {
    chat: t('composer:studio.shortModes.agent'),
    generate: t('composer:studio.shortModes.image'),
    video: t('composer:studio.shortModes.video'),
    canvas: t('composer:studio.shortModes.canvas'),
  }
  const fullName = useOverflowTitle<HTMLSpanElement>(labels[target], { whenHidden: true })
  return (
    <Select value={target} onValueChange={(next) => setTarget(next as Target)}>
      <Hint tooltip={fullName.title}>
        <SelectTrigger aria-label={t('shell:createTarget.aria')} className="creation-mode-trigger">
          <SelectValue>
            <span className="creation-mode-value">
              <Icon name={ICONS[target]} />
              <span ref={fullName.ref} className="creation-mode-full">
                {labels[target]}
              </span>
              <span className="creation-mode-short">{shortLabels[target]}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
      </Hint>
      <SelectContent side="bottom" align="start" sideOffset={10} className="creation-mode-menu">
        {targets.map((one) => (
          <SelectItem key={one} value={one} className="creation-mode-option">
            <span className="flex items-center gap-3">
              <Icon name={ICONS[one]} />
              {labels[one]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
