import { ArrowRightLeft } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { Field, Segmented } from '../components/fields'
import { formatLabel, type OutputFormat } from '../lib/encode'
import { plan } from '../lib/geometry'
import { runPlan } from '../lib/pipeline'
import type { EachTool, ToolSource } from '../lib/tool'

type Target = Exclude<OutputFormat, 'keep'>
const TARGETS: readonly Target[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']

interface ConvertParams {
  format: Target
  quality: number
}

export function convertImage(source: ToolSource, params: ConvertParams) {
  const geometry = plan(source.bitmap.width, source.bitmap.height, {})
  return runPlan(source, geometry, params.format, params.quality / 100)
}

export const convertTool: EachTool = {
  id: 'convert',
  group: 'process',
  kind: 'each',
  icon: ArrowRightLeft,
  useController() {
    const { t } = useTranslation('toolbox')
    const [params, setParams] = useState<ConvertParams>({ format: 'image/webp', quality: 90 })
    return {
      controls: (
        <>
          <Field label={t('params.convertTo')}>
            <Segmented
              label={t('params.convertTo')}
              value={params.format}
              options={TARGETS.map((value) => ({ value, label: formatLabel(value) }))}
              onChange={(format) => setParams((prev) => ({ ...prev, format }))}
            />
          </Field>
          {params.format !== 'image/png' && (
            <Field label={t('params.quality')}>
              <div className="flex h-8 w-56 items-center gap-3">
                <Slider
                  min={5}
                  max={100}
                  step={1}
                  value={[params.quality]}
                  onValueChange={([quality]) => setParams((prev) => ({ ...prev, quality }))}
                  aria-label={t('params.quality')}
                />
                <span className="w-8 text-right text-xs tabular-nums">{params.quality}</span>
              </div>
            </Field>
          )}
        </>
      ),
      run: useCallback((source: ToolSource) => convertImage(source, params), [params]),
    }
  },
}
