import { i18next } from '../i18n'
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
  const t = i18next.getFixedT(null, 'lib')
  const labels: Record<string, string> = {
    background: t('legacyProduct.background'),
    'replace-product': t('legacyProduct.replaceProduct'),
    'replace-and-background': t('legacyProduct.replaceAndBackground'),
    remix: t('legacyProduct.remix'),
  }
  const used = new Set(
    job?.images.flatMap((image) => image.versions.map((v) => v.mode ?? 'background')),
  )
  return Object.entries(labels)
    .filter(([key]) => used.has(key))
    .map(([, label]) => label)
}
