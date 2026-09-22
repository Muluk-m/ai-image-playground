import { STORE_LOOKS } from '../../../lib/db'
import type { LookRecord } from '../types'
import { createRecordStore } from './recordStore'

/** 模板要占的素材图：参考图加封面，与素材的视角图走同一条上下行路径与同一项配额。 */
export function lookImageIds(look: LookRecord): string[] {
  const ids = [...look.referenceImageIds]
  if (look.coverImageId) ids.push(look.coverImageId)
  return [...new Set(ids)]
}

/** 模板存储后端。服务端实现替换 lookStore 这一个绑定即可。 */
export const lookStore = createRecordStore<LookRecord>(STORE_LOOKS, lookImageIds)
