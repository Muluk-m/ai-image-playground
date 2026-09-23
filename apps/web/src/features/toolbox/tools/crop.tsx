import { Crop } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { Field, Segmented } from '../components/fields'
import { centerCrop, plan } from '../lib/geometry'
import { runPlan } from '../lib/pipeline'
import type { EachTool, ToolSource } from '../lib/tool'

/** 比例预设只裁不缩；平台预设裁完再定到那个尺寸（源图不够大时会放大，卡片标「已放大」）。 */
export const CROP_PRESETS = {
  r1x1: { ratio: 1 },
  r4x3: { ratio: 4 / 3 },
  r3x4: { ratio: 3 / 4 },
  r16x9: { ratio: 16 / 9 },
  r9x16: { ratio: 9 / 16 },
  taobao: { ratio: 1, size: [800, 800] },
  amazon: { ratio: 1, size: [2000, 2000] },
  xiaohongshu: { ratio: 1242 / 1660, size: [1242, 1660] },
  douyin: { ratio: 9 / 16, size: [1080, 1920] },
  wechatCover: { ratio: 900 / 383, size: [900, 383] },
} satisfies Record<string, { ratio: number; size?: readonly [number, number] }>

export type CropPresetId = keyof typeof CROP_PRESETS
const PRESET_IDS = Object.keys(CROP_PRESETS) as CropPresetId[]

export function cropImage(source: ToolSource, presetId: CropPresetId) {
  const preset: { ratio: number; size?: readonly [number, number] } = CROP_PRESETS[presetId]
  const geometry = plan(source.bitmap.width, source.bitmap.height, {
    crop: (width, height) => centerCrop(width, height, preset.ratio),
    output: (crop) =>
      preset.size
        ? { width: preset.size[0], height: preset.size[1] }
        : { width: crop.width, height: crop.height },
  })
  return runPlan(source, geometry, 'keep')
}

export const cropTool: EachTool = {
  id: 'crop',
  group: 'process',
  kind: 'each',
  icon: Crop,
  useController() {
    const { t } = useTranslation('toolbox')
    const [preset, setPreset] = useState<CropPresetId>('r1x1')
    return {
      controls: (
        <Field label={t('params.cropTo')}>
          <Segmented
            label={t('params.cropTo')}
            value={preset}
            options={PRESET_IDS.map((value) => ({ value, label: t(`params.cropPreset.${value}`) }))}
            onChange={setPreset}
          />
        </Field>
      ),
      run: useCallback((source: ToolSource) => cropImage(source, preset), [preset]),
    }
  },
}
