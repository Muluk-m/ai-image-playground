import { useTranslation } from '../../../i18n'
import { Field, NumberField, Segmented } from './fields'

const BACKGROUNDS = ['ffffff', '000000', 'f3f4f6'] as const

/** 拼图与长图共用的「间距 + 底色」两格。颜色存 CSS 值，显示名按 hex 查语料。 */
export function GapAndBackground({
  gap,
  background,
  onChange,
}: {
  gap: number
  background: string
  onChange: (patch: { gap?: number; background?: string }) => void
}) {
  const { t } = useTranslation('toolbox')
  return (
    <>
      <Field label={t('params.gap')}>
        <NumberField
          label={t('params.gap')}
          value={gap}
          min={0}
          unit="px"
          onChange={(next) => onChange({ gap: next })}
        />
      </Field>
      <Field label={t('params.background')}>
        <Segmented
          label={t('params.background')}
          value={background}
          options={BACKGROUNDS.map((hex) => ({
            value: `#${hex}`,
            label: t(`params.color.${hex}`),
          }))}
          onChange={(next) => onChange({ background: next })}
        />
      </Field>
    </>
  )
}
