import { dbTransaction, STORE_STORYBOARDS } from '../../../../lib/db'
import type { StoryboardRecord } from '../types'

/** 分镜存储后端。服务端实现替换 storyboardStore 这一个绑定即可。 */
export interface StoryboardStore {
  list(): Promise<StoryboardRecord[]>
  put(record: StoryboardRecord): Promise<void>
  remove(id: string): Promise<void>
}

export const storyboardStore: StoryboardStore = {
  list: () => dbTransaction<StoryboardRecord[]>(STORE_STORYBOARDS, 'readonly', (s) => s.getAll()),
  put: (record) =>
    dbTransaction(STORE_STORYBOARDS, 'readwrite', (s) => s.put(record)).then(() => {}),
  remove: (id) => dbTransaction(STORE_STORYBOARDS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
