import { userSegmentFilters as readUserSegmentFilters } from '@image-playground/read-models'
import { getAdminCapabilities } from '../config'
import type { getDbHandle } from './db'

export function userSegmentFilters(db: ReturnType<typeof getDbHandle>['db']) {
  return readUserSegmentFilters(db, {
    billingCreditsEnabled: getAdminCapabilities().billingCredits,
  })
}
