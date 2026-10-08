import type { Metadata } from 'sharp'

export const MEDIA_IMAGE_MAX_PIXELS = 40_000_000
export const MEDIA_UPLOAD_MAX_PIXELS = 1_000_000_000
const MAX_EDGE = 32_768
const DECODE_WORKING_SET_BYTES = 896 * 1024 * 1024

type DecodeMetadata = Pick<
  Metadata,
  'width' | 'height' | 'channels' | 'depth' | 'isProgressive' | 'format'
>

function sampleBytes(depth: Metadata['depth']): number {
  switch (depth) {
    case 'uchar':
    case 'char':
      return 1
    case 'uint':
    case 'int':
    case 'float':
      return 4
    case 'double':
      return 8
    default:
      return 2
  }
}

/** Wide rows and progressive scans can defeat streaming even when the file is tiny. */
export function assertMediaImageProcessingBudget(metadata: DecodeMetadata): void {
  if (Math.max(metadata.width, metadata.height) > MAX_EDGE) throw new Error('processing_budget')
  if (!metadata.isProgressive && metadata.format !== 'webp') return
  // Reserve room for scan buffers as well as the decoded image and compressed originals.
  // WebP's native decode buffers use four channels even for an opaque RGB image.
  const channels = metadata.format === 'webp' ? 4 : metadata.channels
  const workingSet = metadata.width * metadata.height * channels * sampleBytes(metadata.depth) * 2
  if (workingSet > DECODE_WORKING_SET_BYTES) throw new Error('processing_budget')
}
