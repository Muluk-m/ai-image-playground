import { useTranslation } from '../../i18n'
import { isVideoModeAvailable } from '../../lib/channels/videoChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { useFeatureNew, useGroupHasNew } from '../../lib/featureDiscovery'
import { useStore } from '../../store'
import type { IconName } from '../ui/icon'
import { CreationOptionPicker } from './CreationFrame'

type Target = 'chat' | 'generate' | 'batch' | 'video' | 'canvas'

const ICONS: Record<Target, IconName> = {
  chat: 'chat',
  generate: 'imageAdd',
  batch: 'layers',
  video: 'video',
  canvas: 'canvas',
}

/**
 * 首页输入框里的创作方式：对话、直出、批量生图、视频和画布收进同一个下拉，
 * 切换只改去向，输入框里的提示词和参考图原样留着（切进批量时被引用的图自动归入共用参考）。
 */
export default function HomeTargetPicker() {
  const { t } = useTranslation(['composer', 'shell'])
  const target = useStore((s) => s.createTarget)
  const setTarget = useStore((s) => s.setCreateTarget)
  const agentEnabled = isClientCapabilityEnabled('agent:chat')
  const batchFeature = useFeatureNew('composer.batchMode')
  const hasNewMode = useGroupHasNew('composer-mode')
  const targets: Target[] = [
    ...(agentEnabled ? (['chat'] as const) : []),
    'generate',
    'batch',
    ...(isVideoModeAvailable() ? (['video'] as const) : []),
    'canvas',
  ]
  const labels: Record<Target, string> = {
    chat: t('shell:createTarget.chat'),
    generate: t('composer:studio.modes.image'),
    batch: t('composer:studio.modes.batch'),
    video: t('composer:studio.modes.video'),
    canvas: agentEnabled ? t('shell:createTarget.canvas') : t('shell:mode.canvas'),
  }
  const shortLabels: Record<Target, string> = {
    chat: t('composer:studio.shortModes.agent'),
    generate: t('composer:studio.shortModes.image'),
    batch: t('composer:studio.shortModes.batch'),
    video: t('composer:studio.shortModes.video'),
    canvas: t('composer:studio.shortModes.canvas'),
  }
  const handleChange = (next: Target) => {
    if (next === 'batch') batchFeature.markSeen()
    setTarget(next)
  }
  return (
    <CreationOptionPicker
      value={target}
      onChange={handleChange}
      label={t('shell:createTarget.aria')}
      side="bottom"
      hasNew={hasNewMode}
      options={targets.map((value) => ({
        value,
        label: labels[value],
        shortLabel: shortLabels[value],
        icon: ICONS[value],
        ...(value === 'batch' && batchFeature.badge ? { badge: 'NEW' } : {}),
      }))}
    />
  )
}
