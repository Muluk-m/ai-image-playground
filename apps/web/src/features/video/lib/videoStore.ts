import { dbTransaction, STORE_VIDEO_TASKS } from '../../../lib/db'
import type { VideoTask } from '../types'

/** 视频任务存储后端。服务端实现替换 videoTaskStore 这一个绑定即可。 */
export interface VideoTaskStore {
  list(): Promise<VideoTask[]>
  put(task: VideoTask): Promise<void>
  remove(id: string): Promise<void>
}

export const videoTaskStore: VideoTaskStore = {
  list: () => dbTransaction<VideoTask[]>(STORE_VIDEO_TASKS, 'readonly', (s) => s.getAll()),
  put: (task) => dbTransaction(STORE_VIDEO_TASKS, 'readwrite', (s) => s.put(task)).then(() => {}),
  remove: (id) => dbTransaction(STORE_VIDEO_TASKS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
