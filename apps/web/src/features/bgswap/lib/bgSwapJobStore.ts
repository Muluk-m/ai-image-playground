import { dbTransaction, STORE_BGSWAP_JOBS } from '../../../lib/db'
import type { BgSwapJobRecord } from '../types'

/** 换背景任务存储后端。服务端实现替换 bgSwapJobStore 这一个绑定即可。 */
export interface BgSwapJobStore {
  list(): Promise<BgSwapJobRecord[]>
  put(job: BgSwapJobRecord): Promise<void>
  remove(id: string): Promise<void>
}

export const bgSwapJobStore: BgSwapJobStore = {
  list: () => dbTransaction<BgSwapJobRecord[]>(STORE_BGSWAP_JOBS, 'readonly', (s) => s.getAll()),
  put: (job) => dbTransaction(STORE_BGSWAP_JOBS, 'readwrite', (s) => s.put(job)).then(() => {}),
  remove: (id) => dbTransaction(STORE_BGSWAP_JOBS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
