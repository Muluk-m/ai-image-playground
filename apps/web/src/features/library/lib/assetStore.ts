import { STORE_ASSETS } from '../../../lib/db'
import type { AssetRecord } from '../types'
import { createRecordStore } from './recordStore'

/** 素材存储后端。服务端实现替换 assetStore 这一个绑定即可。 */
export const assetStore = createRecordStore<AssetRecord>(STORE_ASSETS)
