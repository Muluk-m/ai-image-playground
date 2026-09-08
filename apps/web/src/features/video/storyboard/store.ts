import type {
  StoryboardPlan,
  StoryboardSeconds,
  StoryboardShotCount,
} from '@image-playground/shared'
import { create } from 'zustand'
import { planStoryboard } from '../../../lib/storyboardClient'
import { ensureImageCached, submitPrepared, useStore } from '../../../store'
import type { TaskRecord } from '../../../types'
import { useVideoStore } from '../store'
import { downloadStoryboardZip } from './lib/exportStoryboard'
import { storyboardImageParams } from './lib/shotImage'
import { storyboardStore } from './lib/storyboardStore'
import {
  STORYBOARD_FREE_STYLE,
  type StoryboardDraft,
  type StoryboardRecord,
  type StoryboardShotPatch,
  type StoryboardShotRecord,
  type StoryboardStyle,
} from './types'

const NO_IMAGE = '这一镜还没有分镜图'

export const INITIAL_STORYBOARD_DRAFT: Pick<
  StoryboardDraft,
  'idea' | 'shots' | 'secondsPerShot' | 'style'
> = {
  idea: '',
  shots: 3,
  secondsPerShot: 5,
  style: STORYBOARD_FREE_STYLE,
}

export interface StoryboardState {
  storyboards: StoryboardRecord[]
  activeId: string | null
  loading: boolean
  loaded: boolean
  draft: typeof INITIAL_STORYBOARD_DRAFT

  load(): Promise<void>
  setIdea(idea: string): void
  setShots(shots: StoryboardShotCount): void
  setSecondsPerShot(seconds: StoryboardSeconds): void
  setStyle(style: StoryboardStyle): void

  plan(draft: StoryboardDraft): Promise<string | null>
  /** 用同样的创意重写脚本：镜头文案全换，图与视频重新来。 */
  replan(id: string): Promise<void>
  select(id: string): void
  remove(id: string): Promise<void>
  updateShot(id: string, no: number, patch: StoryboardShotPatch): Promise<void>
  regenerateShotImage(id: string, no: number): Promise<void>
  generateShotVideo(id: string, no: number): Promise<void>
  generateAllVideos(id: string): Promise<void>
  /** 工作台任务跑完后把出图挂回对应的镜。 */
  adoptShotImages(tasks: readonly TaskRecord[]): void
  exportZip(id: string): Promise<void>
}

function byNewest(records: StoryboardRecord[]): StoryboardRecord[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function shotsFromPlan(plan: StoryboardPlan): StoryboardShotRecord[] {
  return plan.shots.map((shot) => ({
    ...shot,
    imageTaskId: null,
    imageId: null,
    videoTaskId: null,
  }))
}

export const useStoryboardStore = create<StoryboardState>((set, get) => {
  async function persist(record: StoryboardRecord): Promise<void> {
    set((state) => ({
      storyboards: byNewest(
        state.storyboards.some((item) => item.id === record.id)
          ? state.storyboards.map((item) => (item.id === record.id ? record : item))
          : [record, ...state.storyboards],
      ),
    }))
    await storyboardStore.put(record)
  }

  async function patchShot(id: string, no: number, patch: Partial<StoryboardShotRecord>) {
    const record = get().storyboards.find((item) => item.id === id)
    if (!record) return
    await persist({
      ...record,
      updatedAt: Date.now(),
      shots: record.shots.map((shot) => (shot.no === no ? { ...shot, ...patch } : shot)),
    })
  }

  async function requestPlan(draft: StoryboardDraft): Promise<StoryboardPlan> {
    const referenceImage = draft.referenceImageId
      ? await ensureImageCached(draft.referenceImageId)
      : undefined
    return planStoryboard({
      idea: draft.idea.trim(),
      shots: draft.shots,
      secondsPerShot: draft.secondsPerShot,
      aspectRatio: draft.aspectRatio,
      ...(draft.style === STORYBOARD_FREE_STYLE ? {} : { style: draft.style }),
      ...(referenceImage ? { referenceImage } : {}),
    })
  }

  async function submitShotImage(id: string, no: number): Promise<void> {
    const record = get().storyboards.find((item) => item.id === id)
    const shot = record?.shots.find((item) => item.no === no)
    if (!record || !shot) return

    const referenceDataUrl = record.referenceImageId
      ? await ensureImageCached(record.referenceImageId)
      : undefined
    const [taskId] = await submitPrepared({
      prompt: shot.imagePrompt,
      inputImages:
        record.referenceImageId && referenceDataUrl
          ? [{ id: record.referenceImageId, dataUrl: referenceDataUrl }]
          : [],
      params: storyboardImageParams(useStore.getState().params, record.aspectRatio),
      origin: { setId: record.id, shotId: `shot-${no}`, kind: 'storyboard' },
    })
    if (!taskId) return
    await patchShot(id, no, { imageTaskId: taskId, imageId: null })
  }

  async function submitAllShotImages(id: string): Promise<void> {
    const record = get().storyboards.find((item) => item.id === id)
    if (!record) return
    for (const shot of record.shots) await submitShotImage(id, shot.no)
  }

  return {
    storyboards: [],
    activeId: null,
    loading: false,
    loaded: false,
    draft: INITIAL_STORYBOARD_DRAFT,

    async load() {
      const stored = byNewest(await storyboardStore.list())
      set((state) => ({
        storyboards: stored,
        loaded: true,
        activeId: state.activeId ?? stored[0]?.id ?? null,
      }))
    },

    setIdea(idea) {
      set((state) => ({ draft: { ...state.draft, idea } }))
    },
    setShots(shots) {
      set((state) => ({ draft: { ...state.draft, shots } }))
    },
    setSecondsPerShot(secondsPerShot) {
      set((state) => ({ draft: { ...state.draft, secondsPerShot } }))
    },
    setStyle(style) {
      set((state) => ({ draft: { ...state.draft, style } }))
    },

    async plan(draft) {
      set({ loading: true })
      try {
        const plan = await requestPlan(draft)
        const now = Date.now()
        const record: StoryboardRecord = {
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
          title: plan.title,
          summary: plan.summary,
          idea: draft.idea.trim(),
          aspectRatio: draft.aspectRatio,
          secondsPerShot: draft.secondsPerShot,
          style: draft.style,
          referenceImageId: draft.referenceImageId,
          shots: shotsFromPlan(plan),
        }
        await persist(record)
        set({ activeId: record.id })
        await submitAllShotImages(record.id)
        return record.id
      } catch (err) {
        useStore.getState().showToast(errorMessage(err), 'error')
        return null
      } finally {
        set({ loading: false })
      }
    },

    async replan(id) {
      const record = get().storyboards.find((item) => item.id === id)
      if (!record) return
      set({ loading: true })
      try {
        const plan = await requestPlan({
          idea: record.idea,
          shots: record.shots.length as StoryboardShotCount,
          secondsPerShot: record.secondsPerShot,
          style: record.style,
          aspectRatio: record.aspectRatio,
          referenceImageId: record.referenceImageId,
        })
        await persist({
          ...record,
          updatedAt: Date.now(),
          title: plan.title,
          summary: plan.summary,
          shots: shotsFromPlan(plan),
        })
        await submitAllShotImages(id)
      } catch (err) {
        useStore.getState().showToast(errorMessage(err), 'error')
      } finally {
        set({ loading: false })
      }
    },

    select(id) {
      set({ activeId: id })
    },

    async remove(id) {
      set((state) => ({
        storyboards: state.storyboards.filter((item) => item.id !== id),
        activeId:
          state.activeId === id
            ? (state.storyboards.find((item) => item.id !== id)?.id ?? null)
            : state.activeId,
      }))
      await storyboardStore.remove(id)
    },

    updateShot(id, no, patch) {
      return patchShot(id, no, patch)
    },

    async regenerateShotImage(id, no) {
      await patchShot(id, no, { imageTaskId: null, imageId: null })
      await submitShotImage(id, no)
    },

    async generateShotVideo(id, no) {
      const record = get().storyboards.find((item) => item.id === id)
      const shot = record?.shots.find((item) => item.no === no)
      if (!record || !shot) return
      if (!shot.imageId) {
        useStore.getState().showToast(NO_IMAGE, 'error')
        return
      }
      const taskId = await useVideoStore.getState().submitFromStoryboard({
        storyboardId: id,
        shotNo: no,
        imageId: shot.imageId,
        prompt: shot.videoPrompt,
        seconds: record.secondsPerShot,
        aspectRatio: record.aspectRatio,
      })
      if (taskId) await patchShot(id, no, { videoTaskId: taskId })
    },

    async generateAllVideos(id) {
      const record = get().storyboards.find((item) => item.id === id)
      if (!record) return
      for (const shot of record.shots) {
        if (shot.imageId && !shot.videoTaskId) await get().generateShotVideo(id, shot.no)
      }
    },

    adoptShotImages(tasks) {
      const imageOf = (taskId: string) => {
        const task = tasks.find((item) => item.id === taskId)
        return task?.status === 'done' ? (task.outputImages[0] ?? null) : null
      }
      for (const record of get().storyboards) {
        const shots = record.shots.map((shot) => {
          if (shot.imageId || !shot.imageTaskId) return shot
          const imageId = imageOf(shot.imageTaskId)
          return imageId ? { ...shot, imageId } : shot
        })
        if (shots.some((shot, index) => shot !== record.shots[index])) {
          void persist({ ...record, updatedAt: Date.now(), shots })
        }
      }
    },

    async exportZip(id) {
      const record = get().storyboards.find((item) => item.id === id)
      if (!record) return
      try {
        await downloadStoryboardZip(record)
        useStore.getState().showToast('开始下载', 'success')
      } catch (err) {
        useStore.getState().showToast(errorMessage(err), 'error')
      }
    },
  }
})
