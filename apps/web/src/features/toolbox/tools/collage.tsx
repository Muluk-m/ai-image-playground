import { LayoutGrid } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { GapAndBackground } from '../components/BackgroundField'
import { Field, Segmented } from '../components/fields'
import { drawLayout, encodeComposed } from '../lib/compose'
import { collageLayout } from '../lib/layout'
import type { CombineTool, ToolSource } from '../lib/tool'

interface CollageParams {
  columns: number
  gap: number
  background: string
}

export async function collageImages(sources: readonly ToolSource[], params: CollageParams) {
  const layout = collageLayout(
    sources.map((source) => source.bitmap),
    params.columns,
    params.gap,
  )
  return [await encodeComposed(drawLayout(sources, layout, params.background))]
}

export const collageTool: CombineTool = {
  id: 'collage',
  group: 'compose',
  kind: 'combine',
  icon: LayoutGrid,
  useController() {
    const { t } = useTranslation('toolbox')
    const [params, setParams] = useState<CollageParams>({
      columns: 3,
      gap: 8,
      background: '#ffffff',
    })
    const patch = (next: Partial<CollageParams>) => setParams((prev) => ({ ...prev, ...next }))
    return {
      controls: (
        <>
          <Field label={t('params.perRow')}>
            <Segmented
              label={t('params.perRow')}
              value={params.columns}
              options={[2, 3, 4].map((value) => ({ value, label: String(value) }))}
              onChange={(columns) => patch({ columns })}
            />
          </Field>
          <GapAndBackground gap={params.gap} background={params.background} onChange={patch} />
        </>
      ),
      combine: useCallback(
        (sources: readonly ToolSource[]) => collageImages(sources, params),
        [params],
      ),
    }
  },
}
