import sharp from 'sharp'
import { maskedEditSettings } from './masked-edit-settings'
import { selectionSettings } from './selection-settings'

/** 原图尺寸对这个模型能不能做原尺寸局部编辑；能做时给出补边后的尺寸，不能时给出那句原因。 */
export function maskedEditSize(
  model: string,
  width: number,
  height: number,
): { paddedWidth: number; paddedHeight: number } | { problem: string } {
  const limits = maskedEditSettings.output
  const customSize = /^gpt-image-2(?:[.-]|$)/.test(model)
  if (
    !customSize &&
    (!/^gpt-image-1(?:[.-]|$)/.test(model) ||
      !['1024x1024', '1536x1024', '1024x1536'].includes(`${width}x${height}`))
  )
    return { problem: '当前模型不支持这张图的原尺寸局部编辑，请选择 GPT Image 2 系列' }
  const paddedWidth = customSize
    ? Math.ceil(width / limits.dimensionMultiple) * limits.dimensionMultiple
    : width
  const paddedHeight = customSize
    ? Math.ceil(height / limits.dimensionMultiple) * limits.dimensionMultiple
    : height
  if (
    Math.max(paddedWidth, paddedHeight) > limits.maxEdge ||
    Math.max(paddedWidth / paddedHeight, paddedHeight / paddedWidth) > limits.maxAspectRatio ||
    paddedWidth * paddedHeight < limits.minPixels ||
    paddedWidth * paddedHeight > limits.maxPixels
  )
    return { problem: '原图尺寸超出模型支持的局部编辑范围，请先调整图片尺寸再选择区域' }
  return { paddedWidth, paddedHeight }
}

export async function prepareMaskedInput(model: string, source: string, mask: string) {
  const bytes = Buffer.from(source.split(',')[1]!, 'base64')
  const metadata = await sharp(bytes, { limitInputPixels: selectionSettings.maxPixels }).metadata()
  const width = metadata.width!
  const height = metadata.height!
  const size = maskedEditSize(model, width, height)
  if ('problem' in size) throw new TypeError(size.problem)
  const { paddedWidth, paddedHeight } = size
  const padding = { top: 0, left: 0, right: paddedWidth - width, bottom: paddedHeight - height }
  if (!padding.right && !padding.bottom)
    return { source, mask, size: `${width}x${height}`, originalSize: { width, height } }
  const toUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`
  return {
    // 只在右侧与底部补保留区，原图像素、选区和坐标完全不变；交付时裁掉补边。
    source: toUrl(
      await sharp(bytes)
        .extend({ ...padding, extendWith: 'copy' })
        .png()
        .toBuffer(),
    ),
    mask: toUrl(
      await sharp(Buffer.from(mask.split(',')[1]!, 'base64'))
        .extend({ ...padding, background: '#ffffffff' })
        .png()
        .toBuffer(),
    ),
    size: `${paddedWidth}x${paddedHeight}`,
    originalSize: { width, height },
  }
}
