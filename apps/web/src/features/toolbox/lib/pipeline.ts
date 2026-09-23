import { encodeCanvas, type OutputFormat, resolveOutputType } from './encode'
import type { Plan } from './geometry'
import { renderPlan } from './render'
import type { ToolOutput, ToolSource } from './tool'

/** 非压缩工具的有损质量：只改几何时不该顺手把画质压下去。 */
export const PRESERVE_QUALITY = 0.92

/** 按几何计划画、按所选格式编码。单张工具（转格式、改尺寸、裁剪、旋转）都走这一条。 */
export async function runPlan(
  source: ToolSource,
  plan: Plan,
  format: OutputFormat,
  quality = PRESERVE_QUALITY,
): Promise<ToolOutput> {
  const type = resolveOutputType(format, source.type)
  const canvas = renderPlan(source.bitmap, plan, type)
  const encoded = await encodeCanvas(canvas, type, type === 'image/png' ? undefined : quality)
  return {
    blob: encoded.blob,
    type: encoded.type,
    fellBack: encoded.fellBack,
    width: plan.width,
    height: plan.height,
    notes: plan.upscaled ? ['upscaled'] : undefined,
  }
}
