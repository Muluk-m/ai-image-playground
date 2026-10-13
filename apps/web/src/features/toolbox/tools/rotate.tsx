import { useCallback, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { Field, Segmented } from '../components/fields'
import { type Orientation, plan, type Rotation, UPRIGHT } from '../lib/geometry'
import { runPlan } from '../lib/pipeline'
import type { EachTool, ToolSource } from '../lib/tool'

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

export function rotateImage(source: ToolSource, orientation: Orientation) {
  const geometry = plan(source.bitmap.width, source.bitmap.height, { orientation })
  return runPlan(source, geometry, 'keep')
}

export const rotateTool: EachTool = {
  id: 'rotate',
  group: 'process',
  kind: 'each',
  icon: 'rotate',
  useController() {
    const { t } = useTranslation('toolbox')
    const [orientation, setOrientation] = useState<Orientation>({ ...UPRIGHT, rotate: 90 })
    const patch = (next: Partial<Orientation>) => setOrientation((prev) => ({ ...prev, ...next }))
    return {
      controls: (
        <>
          <Field label={t('params.rotate')}>
            <Segmented
              label={t('params.rotate')}
              value={orientation.rotate}
              options={ROTATIONS.map((value) => ({ value, label: `${value}°` }))}
              onChange={(rotate) => patch({ rotate })}
            />
          </Field>
          <Field label={t('params.flip')}>
            <div className="flex gap-1.5">
              <Button
                variant={orientation.flipH ? 'secondary' : 'outline'}
                aria-pressed={orientation.flipH}
                onClick={() => patch({ flipH: !orientation.flipH })}
              >
                <Icon name="flipHorizontal" />
                {t('params.flipH')}
              </Button>
              <Button
                variant={orientation.flipV ? 'secondary' : 'outline'}
                aria-pressed={orientation.flipV}
                onClick={() => patch({ flipV: !orientation.flipV })}
              >
                <Icon name="flipVertical" />
                {t('params.flipV')}
              </Button>
            </div>
          </Field>
        </>
      ),
      run: useCallback((source: ToolSource) => rotateImage(source, orientation), [orientation]),
    }
  },
}
