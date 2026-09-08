import { storyboardRangeLabel } from '@image-playground/shared'
import { dbTransaction, STORE_STORYBOARDS } from '../../../../lib/db'
import type { StoryboardRecord, StoryboardShotRecord } from '../types'

/** 分镜存储后端。服务端实现替换 storyboardStore 这一个绑定即可。 */
export interface StoryboardStore {
  list(): Promise<StoryboardRecord[]>
  put(record: StoryboardRecord): Promise<void>
  remove(id: string): Promise<void>
}

/** 旧记录一镜一条视频，没有整条视频的时长与提示词，按镜头时长顺推补出来。 */
function timed(record: StoryboardRecord): StoryboardRecord {
  if (record.videoPrompt !== undefined) return record
  let startSeconds = 0
  const shots: StoryboardShotRecord[] = record.shots.map((shot) => {
    const one = { ...shot, startSeconds }
    startSeconds += shot.seconds
    return one
  })
  return {
    ...record,
    totalSeconds: startSeconds,
    videoPrompt: [
      record.summary,
      ...shots.map(
        (shot) =>
          `镜头${shot.no}（${storyboardRangeLabel(shot)}秒）：${shot.description}，${shot.camera}`,
      ),
    ].join('\n'),
    shotImagesRequested: true,
    videoTaskId: null,
    shots,
  }
}

export const storyboardStore: StoryboardStore = {
  list: () =>
    dbTransaction<StoryboardRecord[]>(STORE_STORYBOARDS, 'readonly', (s) => s.getAll()).then(
      (records) => records.map(timed),
    ),
  put: (record) =>
    dbTransaction(STORE_STORYBOARDS, 'readwrite', (s) => s.put(record)).then(() => {}),
  remove: (id) => dbTransaction(STORE_STORYBOARDS, 'readwrite', (s) => s.delete(id)).then(() => {}),
}
