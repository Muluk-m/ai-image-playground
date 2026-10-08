import type { Metadata } from 'sharp'

export const MEDIA_IMAGE_MAX_PIXELS = 40_000_000
export const MEDIA_UPLOAD_MAX_PIXELS = 1_000_000_000
const MAX_EDGE = 32_768
const PROGRESSIVE_WORKING_SET_BYTES = 896 * 1024 * 1024

type DecodeMetadata = Pick<Metadata, 'width' | 'height' | 'channels' | 'depth' | 'isProgressive'>

/** Wide rows and progressive scans can defeat streaming even when the file is tiny. */
export function assertMediaImageProcessingBudget(metadata: DecodeMetadata): void {
  if (Math.max(metadata.width, metadata.height) > MAX_EDGE) throw new Error('processing_budget')
  if (!metadata.isProgressive) return
  // Reserve room for scan buffers as well as the decoded image and compressed originals.
  const sampleBytes = ['uint', 'int', 'float'].includes(metadata.depth)
    ? 4
    : metadata.depth === 'double'
      ? 8
      : 2
  const workingSet = metadata.width * metadata.height * metadata.channels * sampleBytes * 2
  if (workingSet > PROGRESSIVE_WORKING_SET_BYTES) throw new Error('processing_budget')
}
