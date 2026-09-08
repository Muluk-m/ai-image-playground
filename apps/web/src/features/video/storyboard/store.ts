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
  type StoryboardPlanInput,
  type StoryboardRecord,
  type StoryboardShotPatch,
  type StoryboardShotRecord,
  type StoryboardStyle,
} from './types'

const NO_IMAGE = '这一镜还没有分镜图'

export const INITIAL_STORYBOARD_DRAFT: StoryboardDraft = {
  idea: '',
  shots: 3,
  secondsPerShot: 5,
  style: STORYBOARD_FREE_STYLE,
}

export interface StoryboardState {
  storyboards: StoryboardRecord[]
  activeId: string | null
  loading: boolean
  draft: StoryboardDraft

  load(): Promise<void>
  setIdea(idea: string): void
  setShots(shots: StoryboardShotCount): void
  setSecondsPerShot(seconds: StoryboardSeconds): void
  setStyle(style: StoryboardStyle): void

  plan(input: StoryboardPlanInput): Promise<string | null>
  /** 用同样的创意重写脚本：镜头文案全换，图与视频重新来。 */
  replan(id: string): Promise<string | null>
  select(id: string): void
  remove(id: string): Promise<void>
  updateShot(id: string, no: number, patch: StoryboardShotPatch): Promise<void>
  regenerateShotImage(id: string, no: number): Promise<void>
  generateShotVideo(id: string, no: number): Promise<void>
  generateAllVideos(id: string): Promise<void>
  /** 工作台任务跑完后把出图挂回对应的镜。 */
  adoptShotImages(tasks: ReadonlyMap<string, TaskRecord>): void
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
  const boardOf = (id: string) => get().storyboards.find((item) => item.id === id)

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
    const record = boardOf(id)
    if (!record) return
    await persist({
      ...record,
      updatedAt: Date.now(),
      shots: record.shots.map((shot) => (shot.no === no ? { ...shot, ...patch } : shot)),
    })
  }

  async function submitShotImage(
    record: StoryboardRecord,
    no: number,
    referenceDataUrl: string | undefined,
  ): Promise<void> {
    const shot = record.shots.find((item) => item.no === no)
    if (!shot) return
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
    await patchShot(record.id, no, { imageTaskId: taskId, imageId: null })
  }

  function referenceDataUrl(record: StoryboardRecord): Promise<string | undefined> {
    return record.referenceImageId
      ? ensureImageCached(record.referenceImageId)
      : Promise.resolve(undefined)
  }

  /** 逐条提交：每条都要单独过一次提交门禁，并按提交顺序排进工作台。 */
  async function submitAllShotImages(id: string): Promise<void> {
    const record = boardOf(id)
    if (!record) return
    const reference = await referenceDataUrl(record)
    for (const shot of record.shots) await submitShotImage(record, shot.no, reference)
  }

  async function runPlan(
    input: StoryboardPlanInput,
    toRecord: (plan: StoryboardPlan) => StoryboardRecord,
  ): Promise<string | null> {
    set({ loading: true })
    try {
      const reference = input.referenceImageId
        ? await ensureImageCached(input.referenceImageId)
        : undefined
      const plan = await planStoryboard({
        idea: input.idea.trim(),
        shots: input.shots,
        secondsPerShot: input.secondsPerShot,
        aspectRatio: input.aspectRatio,
        ...(input.style === STORYBOARD_FREE_STYLE ? {} : { style: input.style }),
        ...(reference ? { referenceImage: reference } : {}),
      })
      const record = toRecord(plan)
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
  }

  return {
    storyboards: [],
    activeId: null,
    loading: false,
    draft: INITIAL_STORYBOARD_DRAFT,

    async load() {
      const stored = byNewest(await storyboardStore.list())
      set((state) => ({ storyboards: stored, activeId: state.activeId ?? stored[0]?.id ?? null }))
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

    plan(input) {
      const now = Date.now()
      return runPlan(input, (plan) => ({
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        title: plan.title,
        summary: plan.summary,
        idea: input.idea.trim(),
        aspectRatio: input.aspectRatio,
        secondsPerShot: input.secondsPerShot,
        style: input.style,
        referenceImageId: input.referenceImageId,
        shots: shotsFromPlan(plan),
      }))
    },

    replan(id) {
      const record = boardOf(id)
      if (!record) return Promise.resolve(null)
      return runPlan({ ...record, shots: record.shots.length as StoryboardShotCount }, (plan) => ({
        ...record,
        updatedAt: Date.now(),
        title: plan.title,
        summary: plan.summary,
        shots: shotsFromPlan(plan),
      }))
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
      const record = boardOf(id)
      if (record) await submitShotImage(record, no, await referenceDataUrl(record))
    },

    async generateShotVideo(id, no) {
      const record = boardOf(id)
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
      const record = boardOf(id)
      if (!record) return
      for (const shot of record.shots) {
        if (shot.imageId && !shot.videoTaskId) await get().generateShotVideo(id, shot.no)
      }
    },

    adoptShotImages(tasks) {
      for (const record of get().storyboards) {
        let changed = false
        const shots = record.shots.map((shot) => {
          if (shot.imageId || !shot.imageTaskId) return shot
          const task = tasks.get(shot.imageTaskId)
          if (task?.status !== 'done' || !task.outputImages[0]) return shot
          changed = true
          return { ...shot, imageId: task.outputImages[0] }
        })
        if (changed) void persist({ ...record, updatedAt: Date.now(), shots })
      }
    },

    async exportZip(id) {
      const record = boardOf(id)
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
