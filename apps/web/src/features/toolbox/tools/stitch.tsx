import { GalleryVertical } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { GapAndBackground } from '../components/BackgroundField'
import { Field, Segmented } from '../components/fields'
import { drawLayout, encodeComposed } from '../lib/compose'
import { stitchLayout } from '../lib/layout'
import type { CombineTool, ToolSource } from '../lib/tool'

interface StitchParams {
  direction: 'vertical' | 'horizontal'
  gap: number
  background: string
}

export async function stitchImages(sources: readonly ToolSource[], params: StitchParams) {
  const layout = stitchLayout(
    sources.map((source) => source.bitmap),
    params.direction,
    params.gap,
  )
  return [await encodeComposed(drawLayout(sources, layout, params.background))]
}

export const stitchTool: CombineTool = {
  id: 'stitch',
  group: 'compose',
  kind: 'combine',
  icon: GalleryVertical,
  useController() {
    const { t } = useTranslation('toolbox')
    const [params, setParams] = useState<StitchParams>({
      direction: 'vertical',
      gap: 0,
      background: '#ffffff',
    })
    const patch = (next: Partial<StitchParams>) => setParams((prev) => ({ ...prev, ...next }))
    return {
      controls: (
        <>
          <Field label={t('params.direction')}>
            <Segmented
              label={t('params.direction')}
              value={params.direction}
              options={(['vertical', 'horizontal'] as const).map((value) => ({
                value,
                label: t(`params.${value}`),
              }))}
              onChange={(direction) => patch({ direction })}
            />
          </Field>
          <GapAndBackground gap={params.gap} background={params.background} onChange={patch} />
        </>
      ),
      combine: useCallback(
        (sources: readonly ToolSource[]) => stitchImages(sources, params),
        [params],
      ),
    }
  },
}
