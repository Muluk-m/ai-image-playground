import { useMemo } from 'react'
import { SettingsSection, SettingsSegmented } from '../../../components/composer/SettingsPanel'
import { ImageSettings, ModelChip, type UnsupportedParam } from '../../../components/ParamControls'
import { useTranslation } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { useStore } from '../../../store'
import { useAgentStore } from '../store'

/**
 * 智能体这条路做不到的两项，开关不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

const DEPTHS = ['fast', 'medium', 'deep'] as const

/**
 * 对话面板的模型 chip + 生成设置。和首页、画布生成栏是同一套卡片，只多一组思考深度；
 * 张数由智能体按需求决定，所以没有数量。
 *
 * 自带 Key 的配置在智能体这条路上不生效——服务端没有 BYOK 分支，模型一律从内置渠道里挑。
 * 所以 BYOK 时模型 chip 不写 profile 里那个模型名，卡片底部写明原因。
 */
export default function AgentParamsChip() {
  const { t } = useTranslation('agent')
  const depth = useAgentStore((state) => state.thinkingDepth)
  const setDepth = useAgentStore((state) => state.setThinkingDepth)
  const settings = useStore((state) => state.settings)
  const byok = useMemo(() => getActiveApiProfile(settings).source === 'user-byok', [settings])
  const labels = {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }

  return (
    <>
      <ModelChip size="sm" label={byok ? t('params.builtinModel') : undefined} />
      <ImageSettings
        size="sm"
        unsupported={UNSUPPORTED}
        extra={{
          dirty: depth !== 'medium',
          reset: () => setDepth('medium'),
          section: (
            <SettingsSection title={t('params.thinkingLegend')}>
              <SettingsSegmented
                label={t('params.thinkingLegend')}
                options={DEPTHS.map((value) => ({ value, label: labels[value] }))}
                value={depth}
                onChange={setDepth}
              />
            </SettingsSection>
          ),
          footnote: (
            <div className="space-y-1.5 text-label-sm leading-relaxed text-muted-foreground">
              <p>{t('params.note')}</p>
              {byok && <p>{t('params.byokNote')}</p>}
            </div>
          ),
        }}
      />
    </>
  )
}
