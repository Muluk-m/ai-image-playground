import { Scaling } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { Field, NumberField, Segmented } from '../components/fields'
import { plan, type ResizeRule, resizedSize } from '../lib/geometry'
import { runPlan } from '../lib/pipeline'
import type { EachTool, ToolSource } from '../lib/tool'

const DEFAULTS: Record<ResizeRule['mode'], number> = { longEdge: 1600, width: 1200, percent: 50 }

export function resizeImage(source: ToolSource, rule: ResizeRule) {
  const geometry = plan(source.bitmap.width, source.bitmap.height, {
    output: (crop) => resizedSize(crop.width, crop.height, rule),
  })
  return runPlan(source, geometry, 'keep')
}

export const resizeTool: EachTool = {
  id: 'resize',
  group: 'process',
  kind: 'each',
  icon: Scaling,
  useController() {
    const { t } = useTranslation('toolbox')
    const [rule, setRule] = useState<ResizeRule>({ mode: 'longEdge', value: DEFAULTS.longEdge })
    return {
      controls: (
        <>
          <Field label={t('params.resizeBy')}>
            <Segmented
              label={t('params.resizeBy')}
              value={rule.mode}
              options={(['longEdge', 'width', 'percent'] as const).map((value) => ({
                value,
                label: t(`params.resize.${value}`),
              }))}
              onChange={(mode) => setRule({ mode, value: DEFAULTS[mode] })}
            />
          </Field>
          <Field label={t(`params.resize.${rule.mode}`)}>
            <NumberField
              label={t(`params.resize.${rule.mode}`)}
              value={rule.value}
              unit={rule.mode === 'percent' ? '%' : 'px'}
              onChange={(value) => setRule((prev) => ({ ...prev, value }))}
            />
          </Field>
        </>
      ),
      run: useCallback((source: ToolSource) => resizeImage(source, rule), [rule]),
    }
  },
}
