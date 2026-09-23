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
import { Field } from '../components/fields'
import { encodeCanvas, formatLabel, type OutputFormat, resolveOutputType } from '../lib/encode'
import { createOutputCanvas } from '../lib/render'
import type { ToolDefinition, ToolOutput, ToolSource } from '../lib/tool'

export interface CompressParams {
  format: OutputFormat
  /** 5–100，除以 100 就是 canvas 的 quality。 */
  quality: number
}

/** 压缩不列 PNG：PNG 是无损的，质量滑杆拧不动它（PNG 源的落点规则在 #810）。 */
const FORMATS: readonly OutputFormat[] = ['keep', 'image/jpeg', 'image/webp', 'image/avif']

const DEFAULTS: CompressParams = { format: 'keep', quality: 80 }

const MIN_QUALITY = 5

export async function compressImage(
  source: ToolSource,
  params: CompressParams,
): Promise<ToolOutput> {
  const type = resolveOutputType(params.format, source.type)
  const { width, height } = source.bitmap
  const { canvas, ctx } = createOutputCanvas(width, height, type)
  ctx.drawImage(source.bitmap, 0, 0)
  // PNG 无损，给它 quality 只会被忽略；别的格式都吃这个 0–1 的数。
  const quality = type === 'image/png' ? undefined : params.quality / 100
  const encoded = await encodeCanvas(canvas, type, quality)
  return {
    blob: encoded.blob,
    type: encoded.type,
    fellBack: encoded.fellBack,
    width,
    height,
  }
}

function CompressControls({
  params,
  onChange,
}: {
  params: CompressParams
  onChange: (patch: Partial<CompressParams>) => void
}) {
  const { t } = useTranslation('toolbox')
  return (
    <>
      <Field label={t('params.format')}>
        <Select
          value={params.format}
          onValueChange={(format) => onChange({ format: format as OutputFormat })}
        >
          <SelectTrigger className="h-8 w-36 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {format === 'keep' ? t('params.keepFormat') : formatLabel(format)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('params.quality')}>
        <div className="flex h-8 w-56 items-center gap-3">
          <Slider
            min={MIN_QUALITY}
            max={100}
            step={1}
            value={[params.quality]}
            onValueChange={([quality]) => onChange({ quality })}
            aria-label={t('params.quality')}
          />
          <span className="w-8 text-right text-xs tabular-nums">{params.quality}</span>
        </div>
      </Field>
    </>
  )
}

export const compressTool: ToolDefinition = {
  id: 'compress',
  group: 'process',
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
      // 参数一变换一个新函数，结果才会重算；参数没变时拖别的工具的滑杆不该触发编码。
      run: useCallback((source: ToolSource) => compressImage(source, params), [params]),
    }
  },
}
