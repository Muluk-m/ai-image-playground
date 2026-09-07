import { dbTransaction, STORE_BGSWAP_JOBS } from '../../../lib/db'
import type { ProductShotJob } from '../types'

/** 换背景任务存储后端。服务端实现替换 productShotJobStore 这一个绑定即可。 */
export interface ProductShotJobStore {
  list(): Promise<ProductShotJob[]>
  put(job: ProductShotJob): Promise<void>
  remove(id: string): Promise<void>
}

export const productShotJobStore: ProductShotJobStore = {
  list: () => dbTransaction<ProductShotJob[]>(STORE_BGSWAP_JOBS, 'readonly', (s) => s.getAll()),
  put: (job) => dbTransaction(STORE_BGSWAP_JOBS, 'readwrite', (s) => s.put(job)).then(() => {}),
  remove: (id) => dbTransaction(STORE_BGSWAP_JOBS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
