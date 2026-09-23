import { Grid3x3 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { Field, Segmented } from '../components/fields'
import { encodeComposed } from '../lib/compose'
import { sliceLayout } from '../lib/layout'
import { createOutputCanvas } from '../lib/render'
import type { CombineTool, ToolSource } from '../lib/tool'

const GRIDS = ['3x3', '2x2', '1x3', '3x1'] as const
type Grid = (typeof GRIDS)[number]

interface SliceParams {
  grid: Grid
  squareFirst: boolean
}

export async function sliceImage(source: ToolSource, params: SliceParams) {
  const [rows, columns] = params.grid.split('x').map(Number)
  const { source: origin, tiles } = sliceLayout(source.bitmap, rows, columns, params.squareFirst)
  const outputs = []
  for (const tile of tiles) {
    const { canvas, ctx } = createOutputCanvas(tile.width, tile.height, 'image/jpeg')
    ctx.drawImage(
      source.bitmap,
      origin.x + tile.x,
      origin.y + tile.y,
      tile.width,
      tile.height,
      0,
      0,
      tile.width,
      tile.height,
    )
    outputs.push(await encodeComposed(canvas))
  }
  return outputs
}

export const sliceTool: CombineTool = {
  id: 'slice',
  group: 'compose',
  kind: 'combine',
  icon: Grid3x3,
  useController() {
    const { t } = useTranslation('toolbox')
    const [params, setParams] = useState<SliceParams>({ grid: '3x3', squareFirst: true })
    return {
      sourceLimit: 1,
      previewColumns: Number(params.grid.split('x')[1]),
      controls: (
        <>
          <Field label={t('params.sliceInto')}>
            <Segmented
              label={t('params.sliceInto')}
              value={params.grid}
              options={GRIDS.map((value) => ({ value, label: value.replace('x', '×') }))}
              onChange={(grid) => setParams((prev) => ({ ...prev, grid }))}
            />
          </Field>
          <Field label={t('params.squareFirst')}>
            <Segmented
              label={t('params.squareFirst')}
              value={params.squareFirst ? 'yes' : 'no'}
              options={[
                { value: 'yes', label: t('params.yes') },
                { value: 'no', label: t('params.no') },
              ]}
              onChange={(value) => setParams((prev) => ({ ...prev, squareFirst: value === 'yes' }))}
            />
          </Field>
        </>
      ),
      combine: useCallback(
        (sources: readonly ToolSource[]) => sliceImage(sources[0], params),
        [params],
      ),
    }
  },
}
