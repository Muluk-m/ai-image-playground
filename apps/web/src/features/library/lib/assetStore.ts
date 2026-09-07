import { STORE_ASSETS } from '../../../lib/db'
import type { AssetRecord } from '../types'
import { createRecordStore, type RecordStore } from './recordStore'

/** 素材存储后端。服务端实现替换 assetStore 这一个绑定即可。 */
export type AssetStore = RecordStore<AssetRecord>

export const assetStore: AssetStore = createRecordStore<AssetRecord>(STORE_ASSETS)
