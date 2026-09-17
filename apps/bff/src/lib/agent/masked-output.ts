import sharp from 'sharp'
import { inspectMaskedAlignment } from './masked-alignment'
import { inwardMaskDistance } from './masked-boundary'
import { maskedEditSettings } from './masked-edit-settings'
import { selectionSettings } from './selection-settings'

export class MaskedOutputError extends Error {}

async function pixels(bytes: Uint8Array) {
  const image = sharp(bytes, { limitInputPixels: selectionSettings.maxPixels })
  const metadata = await image.metadata()
  if ((metadata.orientation ?? 1) !== 1 || (metadata.pages ?? 1) !== 1)
    throw new MaskedOutputError('生成图的方向或帧数无法与选区对应，未应用修改')
  return image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

/** 只在原图坐标内合成；轻微等比缩放须有分散的保护区纹理证据才可校正。 */
export async function protectMaskedOutput(
  sourceDataUrl: string,
  maskDataUrl: string,
  originalSize?: { width: number; height: number },
) {
  const decode = (value: string) => Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')
  const source = await pixels(decode(sourceDataUrl))
  const maskBytes = decode(maskDataUrl)
  if (!(await sharp(maskBytes).metadata()).hasAlpha)
    throw new MaskedOutputError('选区缺少透明通道，未提交编辑')
  const mask = await pixels(maskBytes)
  const { width, height } = source.info
  if (width !== mask.info.width || height !== mask.info.height)
    throw new MaskedOutputError('选区尺寸与原图不一致，未提交编辑')
  if (!mask.data.some((value, index) => index % 4 === 3 && value < 255))
    throw new MaskedOutputError('没有选中编辑区域，未提交编辑')
  const featherPixels =
    Math.min(width, height) >= maskedEditSettings.boundary.minImageEdge
      ? maskedEditSettings.boundary.featherPixels
      : 0
  const boundary = featherPixels
    ? inwardMaskDistance(mask.data, width, height, featherPixels)
    : undefined

  return async (candidate: Uint8Array) => {
    try {
      let generated = await pixels(candidate)
      const candidateWidth = generated.info.width,
        candidateHeight = generated.info.height
      const rescaled = generated.info.width !== width || generated.info.height !== height
      if (rescaled) {
        const limits = maskedEditSettings.rescale
        const sx = generated.info.width / width,
          sy = generated.info.height / height
        if (
          Math.max(Math.abs(1 - sx), Math.abs(1 - sy)) > limits.maxScaleDifference ||
          Math.abs(sx / sy - 1) > limits.maxAspectDifference
        )
          throw new MaskedOutputError(
            '生成图尺寸与原图不一致，无法保护选区外内容；候选已保留，未应用修改',
          )
        // 此时只是待验证的尺度假设；没有足够原位纹理证据就拒绝，不盲目贴回。
        generated = await pixels(
          await sharp(generated.data, { raw: generated.info })
            .resize(width, height, { fit: 'fill' })
            .png()
            .toBuffer(),
        )
      }
      const alignment = inspectMaskedAlignment(
        source.data,
        generated.data,
        mask.data,
        width,
        height,
      )
      if (
        !alignment.accepted ||
        (rescaled &&
          (alignment.texturedRegions < maskedEditSettings.rescale.minTexturedRegions ||
            alignment.matchedQuadrants < maskedEditSettings.rescale.minMatchedQuadrants))
      )
        throw new MaskedOutputError('生成图与原图的位置对应无法确认；候选已保留，未应用修改')
      const output = Buffer.from(source.data)
      let outsideChangedPixels = 0
      let insideChangedPixels = 0
      for (let offset = 0; offset < output.length; offset += 4) {
        const amount =
          (1 - mask.data[offset + 3]! / 255) *
          (boundary ? boundary[offset / 4]! / featherPixels : 1)
        const changed =
          generated.data[offset] !== source.data[offset] ||
          generated.data[offset + 1] !== source.data[offset + 1] ||
          generated.data[offset + 2] !== source.data[offset + 2] ||
          generated.data[offset + 3] !== source.data[offset + 3]
        if (amount === 0) {
          if (changed) outsideChangedPixels++
          continue
        }
        if (changed) insideChangedPixels++
        const sourceAlpha = source.data[offset + 3]! / 255
        const candidateAlpha = generated.data[offset + 3]! / 255
        const alpha = sourceAlpha * (1 - amount) + candidateAlpha * amount
        for (let channel = 0; channel < 3; channel++) {
          output[offset + channel] =
            alpha === 0
              ? 0
              : Math.round(
                  (source.data[offset + channel]! * sourceAlpha * (1 - amount) +
                    generated.data[offset + channel]! * candidateAlpha * amount) /
                    alpha,
                )
        }
        output[offset + 3] = Math.round(alpha * 255)
      }
      let image = sharp(output, { raw: { width, height, channels: 4 } })
      if (originalSize) image = image.extract({ left: 0, top: 0, ...originalSize })
      return {
        bytes: await image.png().toBuffer(),
        mime: 'image/png',
        inspection: {
          outsideChangedPixels,
          insideChangedPixels,
          width: originalSize?.width ?? width,
          height: originalSize?.height ?? height,
          texturedRegions: alignment.texturedRegions,
          matchedRegions: alignment.matchedRegions,
          matchedQuadrants: alignment.matchedQuadrants,
          rescaled: Number(rescaled),
          boundaryFeatherPixels: featherPixels,
          candidateWidth,
          candidateHeight,
          workingWidth: width,
          workingHeight: height,
          scaleX: width / candidateWidth,
          scaleY: height / candidateHeight,
        },
      }
    } catch (error) {
      if (error instanceof MaskedOutputError) throw error
      throw new MaskedOutputError('生成图无法与原图选区对应；候选已保留，未应用修改', {
        cause: error,
      })
    }
  }
}
