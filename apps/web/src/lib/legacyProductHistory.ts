import { dbTransaction, STORE_BGSWAP_JOBS } from './db'

/** Retired product workflows remain readable so history and image retention stay intact. */
export interface LegacyProductJob {
  id: string
  name: string
  images: Array<{
    imageId: string
    sourceMatte?: {
      status: string
      previewImageId?: string | null
      alphaImageId?: string
      targetImageId?: string
    }
    versions: Array<{
      mode?: string
      maskImageId?: string | null
      maskTargetImageId?: string | null
      mattePreviewImageId?: string | null
      workflow?: { sourceImageId: string; inputImageIds: string[] }
    }>
  }>
}

export function readLegacyProductJobs(): Promise<LegacyProductJob[]> {
  return dbTransaction(STORE_BGSWAP_JOBS, 'readonly', (store) => store.getAll())
}

export function legacyActionLabels(job: LegacyProductJob | undefined): string[] {
  const labels: Record<string, string> = {
    background: '换背景',
    'replace-product': '换产品',
    'replace-and-background': '换产品并换背景',
    remix: '借创意重做',
  }
  const used = new Set(
    job?.images.flatMap((image) => image.versions.map((v) => v.mode ?? 'background')),
  )
  return Object.entries(labels)
    .filter(([key]) => used.has(key))
    .map(([, label]) => label)
}
