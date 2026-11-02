import { useTranslation } from '../../i18n'
import { isVideoModeAvailable } from '../../lib/channels/videoChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { useStore } from '../../store'
import type { IconName } from '../ui/icon'
import { CreationOptionPicker } from './CreationFrame'

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
  return (
    <CreationOptionPicker
      value={target}
      onChange={setTarget}
      label={t('shell:createTarget.aria')}
      side="bottom"
      options={targets.map((value) => ({
        value,
        label: labels[value],
        shortLabel: shortLabels[value],
        icon: ICONS[value],
      }))}
    />
  )
}
