import { Minimize2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { Field, NumberField, Segmented } from '../components/fields'
import { encodeCanvas, formatLabel } from '../lib/encode'
import { plan } from '../lib/geometry'
import { renderPlan } from '../lib/render'
import { searchQualityForSize } from '../lib/targetSize'
import type { EachTool, ToolOutput, ToolSource } from '../lib/tool'
import { optimisePng } from '../lib/wasmEncoder'

/** `auto`：JPG / WebP / AVIF 保持原格式；PNG 与编不出的格式（HEIC、GIF…）出 WebP——PNG 无损，按质量压不动它。 */
export type CompressFormat = 'auto' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
const FORMATS: readonly CompressFormat[] = [
  'auto',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/png',
]
const LOSSY_KEEP: Record<string, true> = {
  'image/jpeg': true,
  'image/webp': true,
  'image/avif': true,
}

export interface CompressParams {
  format: CompressFormat
  mode: 'quality' | 'target'
  /** 5–100。 */
  quality: number
  targetKb: number
}

const DEFAULTS: CompressParams = { format: 'auto', mode: 'quality', quality: 80, targetKb: 200 }

export function compressOutputType(format: CompressFormat, sourceType: string): string {
  if (format !== 'auto') return format
  return LOSSY_KEEP[sourceType] ? sourceType : 'image/webp'
}

function original(source: ToolSource): ToolOutput {
  return {
    blob: source.file,
    type: source.type,
    width: source.bitmap.width,
    height: source.bitmap.height,
    fellBack: false,
    notes: ['keptOriginal'],
  }
}

export async function compressImage(
  source: ToolSource,
  params: CompressParams,
): Promise<ToolOutput> {
  const type = compressOutputType(params.format, source.type)
  const sameFormat = type === source.type
  const targetBytes = params.targetKb * 1024
  // 原图已经达标、格式也不用变：再编一遍只会更糊，还可能更大。
  if (params.mode === 'target' && sameFormat && source.size <= targetBytes) return original(source)

  const geometry = plan(source.bitmap.width, source.bitmap.height, {})
  const canvas = renderPlan(source.bitmap, geometry, type)
  let output: ToolOutput
  if (type === 'image/png') {
    const encoded = await encodeCanvas(canvas, type)
    const blob = await optimisePng(encoded.blob).catch(() => encoded.blob)
    output = { ...encoded, blob, width: canvas.width, height: canvas.height }
  } else if (params.mode === 'target') {
    const { result, overTarget } = await searchQualityForSize(async (quality) => {
      const encoded = await encodeCanvas(canvas, type, quality)
      return { ...encoded, size: encoded.blob.size }
    }, targetBytes)
    output = {
      blob: result.blob,
      type: result.type,
      fellBack: result.fellBack,
      width: canvas.width,
      height: canvas.height,
      notes: overTarget ? ['overTarget'] : undefined,
    }
  } else {
    const encoded = await encodeCanvas(canvas, type, params.quality / 100)
    output = { ...encoded, width: canvas.width, height: canvas.height }
  }
  // 格式没变、体积却涨了：交原图。格式变了的话用户要的就是新格式，照给。
  if (sameFormat && output.blob.size >= source.size) return original(source)
  return output
}

function CompressControls({
  params,
  onChange,
}: {
  params: CompressParams
  onChange: (patch: Partial<CompressParams>) => void
}) {
  const { t } = useTranslation('toolbox')
  const lossless = params.format === 'image/png'
  return (
    <>
      <Field label={t('params.format')}>
        <Select
          value={params.format}
          onValueChange={(format) => onChange({ format: format as CompressFormat })}
        >
          <SelectTrigger className="h-8 w-36 text-[13px]" aria-label={t('params.format')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {format === 'auto' ? t('params.autoFormat') : formatLabel(format)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {!lossless && (
        <Field label={t('params.compressBy')}>
          <Segmented
            label={t('params.compressBy')}
            value={params.mode}
            options={[
              { value: 'quality', label: t('params.byQuality') },
              { value: 'target', label: t('params.byTarget') },
            ]}
            onChange={(mode) => onChange({ mode })}
          />
        </Field>
      )}
      {!lossless && params.mode === 'quality' && (
        <Field label={t('params.quality')}>
          <div className="flex h-8 w-56 items-center gap-3">
            <Slider
              min={5}
              max={100}
              step={1}
              value={[params.quality]}
              onValueChange={([quality]) => onChange({ quality })}
              aria-label={t('params.quality')}
            />
            <span className="w-8 text-right text-xs tabular-nums">{params.quality}</span>
          </div>
        </Field>
      )}
      {!lossless && params.mode === 'target' && (
        <Field label={t('params.atMost')}>
          <NumberField
            label={t('params.atMost')}
            value={params.targetKb}
            unit="KB"
            onChange={(targetKb) => onChange({ targetKb })}
          />
        </Field>
      )}
    </>
  )
}

export const compressTool: EachTool = {
  id: 'compress',
  group: 'process',
  kind: 'each',
  icon: Minimize2,
  useController() {
    const [params, setParams] = useState(DEFAULTS)
    return {
      controls: (
        <CompressControls
          params={params}
          onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
        />
      ),
      // 参数一变换一个新函数，结果才会重算。
      run: useCallback((source: ToolSource) => compressImage(source, params), [params]),
    }
  },
}
