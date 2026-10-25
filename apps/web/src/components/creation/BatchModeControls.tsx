import { useTranslation } from '../../i18n'
import { BATCH_GENERATE_MAX, batchMergeLocked } from '../../lib/batchGenerate'
import { SettingsSegmented } from '../composer/SettingsPanel'

/**
 * 快速生成带了多张参考图时，参考区标题里的二选一：合并成一组参考出图，或每张图各跑一次。
 * 超过合并参考的上限时「合并参考」置灰，旁边写明原因。
 */
export function BatchModeControls({
  count,
  mergeLimit,
  perImage,
  onChange,
}: {
  count: number
  /** 模型一次能带的参考图数；超过它「合并参考」置灰。 */
  mergeLimit: number
  perImage: boolean
  onChange: (perImage: boolean) => void
}) {
  const { t } = useTranslation('composer')
  const locked = batchMergeLocked(count, mergeLimit)
  const note = locked
    ? t('batch.mergeLimit', { max: mergeLimit })
    : count >= BATCH_GENERATE_MAX
      ? t('batch.full')
      : null
  return (
    <div className="creation-batch-controls">
      <div className="creation-batch-segmented">
        <SettingsSegmented
          label={t('batch.usage')}
          options={[
            { value: 'merge', label: t('batch.merge'), disabled: locked },
            { value: 'each', label: t('batch.each') },
          ]}
          value={perImage ? 'each' : 'merge'}
          onChange={(value) => onChange(value === 'each')}
        />
      </div>
      <span className="creation-batch-count">
        <span className="text-foreground">
          {t('batch.selected', { count, max: BATCH_GENERATE_MAX })}
        </span>
        {note && <span>{note}</span>}
      </span>
    </div>
  )
}
