import { dbTransaction, STORE_TEMPLATES } from '../../../lib/db'
import type { TemplateRecord } from '../types'

/** 模板存储后端。服务端实现替换 templateStore 这一个绑定即可。 */
export interface TemplateStore {
  list(): Promise<TemplateRecord[]>
  put(template: TemplateRecord): Promise<void>
  remove(id: string): Promise<void>
}

export const templateStore: TemplateStore = {
  list: () => dbTransaction<TemplateRecord[]>(STORE_TEMPLATES, 'readonly', (s) => s.getAll()),
  put: (template) =>
    dbTransaction(STORE_TEMPLATES, 'readwrite', (s) => s.put(template)).then(() => {}),
  remove: (id) => dbTransaction(STORE_TEMPLATES, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
