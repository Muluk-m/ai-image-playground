import {
  STORYBOARD_MAX_REFERENCE_IMAGES,
  type StoryboardPlan,
  type StoryboardShotCount,
  type StoryboardTotalSeconds,
} from '@image-playground/shared'
import { create } from 'zustand'
import { planStoryboard } from '../../../lib/storyboardClient'
import { ensureImageCached, storeImageFromFile, submitPrepared, useStore } from '../../../store'
import type { InputImage, TaskRecord } from '../../../types'
import { useVideoStore } from '../store'
import {
  sameStoryboard,
  sequencePrompt,
  sequenceShots,
  shotPrompt,
  storyboardContent,
} from './lib/director'
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
  type StoryboardVersion,
} from './types'

const NO_IMAGE = '这一镜还没有分镜图'
const TOO_MANY_REFERENCES = `最多 ${STORYBOARD_MAX_REFERENCE_IMAGES} 张参考图`

/** 给用户的预期，不是超时。 */
export const STORYBOARD_PLAN_TYPICAL_SECONDS = 60

export const INITIAL_STORYBOARD_DRAFT: StoryboardDraft = {
  idea: '',
  shots: 3,
  totalSeconds: 15,
  style: STORYBOARD_FREE_STYLE,
  referenceImageIds: [],
  shotImages: true,
}

export interface StoryboardState {
  storyboards: StoryboardRecord[]
  activeId: string | null
  loadingSince: number | null
  draft: StoryboardDraft
  saveStates: Record<string, 'saving' | 'saved' | 'error'>
  loadError: string | null
  saveVersion(id: string, name: string): Promise<StoryboardVersion | null>
  restoreVersion(id: string, versionId: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  retrySave(id: string): Promise<void>
  moveShot(id: string, no: number, direction: -1 | 1): Promise<void>
  addShot(id: string, copyNo?: number): Promise<void>
  removeShot(id: string, no: number): Promise<void>

  load(): Promise<void>
  setIdea(idea: string): void
  setShots(shots: StoryboardShotCount): void
  setTotalSeconds(totalSeconds: StoryboardTotalSeconds): void
  setStyle(style: StoryboardStyle): void
  setShotImages(shotImages: boolean): void
  /** 已选的再点一次拿掉；已满时只提示，不挤掉已选的。 */
  toggleReference(imageId: string): void
  removeReference(imageId: string): void
  addReferencesFromFiles(files: File[]): Promise<void>

  plan(input: StoryboardPlanInput): Promise<string | null>
  /** 用同样的创意重写脚本：镜头文案全换，图与视频重新来。 */
  replan(id: string): Promise<string | null>
  select(id: string): void
  remove(id: string): Promise<void>
  updateShot(id: string, no: number, patch: StoryboardShotPatch): Promise<void>
  updateVideoPrompt(id: string, videoPrompt: string): Promise<void>
  regenerateShotImage(id: string, no: number): Promise<void>
  generateMissingShotImages(id: string): Promise<void>
  generateShotVideo(id: string, no: number): Promise<string | null>
  /** 整条分镜出成一条视频：一条多镜提示词，时长是分镜总时长。 */
  generateWholeVideo(id: string): Promise<string | null>
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

/** 整条视频的首帧：第一镜出了图就用它，否则用第一张参考图，都没有就纯文生。 */
export function wholeVideoFrameId(record: StoryboardRecord): string | null {
  return record.shots[0]?.imageId ?? record.referenceImageIds[0] ?? null
}

export const useStoryboardStore = create<StoryboardState>((set, get) => {
  const boardOf = (id: string) => get().storyboards.find((item) => item.id === id)

  function roomForReference(): boolean {
    if (get().draft.referenceImageIds.length < STORYBOARD_MAX_REFERENCE_IMAGES) return true
    useStore.getState().showToast(TOO_MANY_REFERENCES, 'error')
    return false
  }

  const deleting = new Set<string>()
  const writes = new Map<string, Promise<boolean>>()
  const saveSequence = new Map<string, number>()

  async function persist(record: StoryboardRecord): Promise<boolean> {
    if (deleting.has(record.id)) return false
    const sequence = (saveSequence.get(record.id) ?? 0) + 1
    saveSequence.set(record.id, sequence)
    set((state) => ({
      storyboards: byNewest(
        state.storyboards.some((item) => item.id === record.id)
          ? state.storyboards.map((item) => (item.id === record.id ? record : item))
          : [record, ...state.storyboards],
      ),
      saveStates: { ...state.saveStates, [record.id]: 'saving' },
    }))
    const pending = (writes.get(record.id) ?? Promise.resolve(true)).then(async () => {
      try {
        await storyboardStore.put(record)
        if (saveSequence.get(record.id) === sequence) {
          set((state) => ({ saveStates: { ...state.saveStates, [record.id]: 'saved' } }))
        }
        return true
      } catch (err) {
        if (saveSequence.get(record.id) === sequence) {
          set((state) => ({ saveStates: { ...state.saveStates, [record.id]: 'error' } }))
          useStore.getState().showToast(`分镜保存失败：${errorMessage(err)}`, 'error')
        }
        return false
      }
    })
    writes.set(record.id, pending)
    const saved = await pending
    if (writes.get(record.id) === pending) writes.delete(record.id)
    return saved
  }

  async function versionForGeneration(id: string): Promise<StoryboardVersion | null> {
    const record = boardOf(id)
    if (!record) return null
    const content = storyboardContent(record)
    const existing = record.versions?.find((version) => sameStoryboard(version.content, content))
    if (!existing) return get().saveVersion(id, '生成前快照')
    return (await persist(record)) ? structuredClone(existing) : null
  }

  async function editSequence(
    record: StoryboardRecord,
    next: StoryboardShotRecord[],
  ): Promise<void> {
    const shots = sequenceShots(next)
    await patchBoard(record.id, {
      shots,
      totalSeconds: shots.reduce((sum, shot) => sum + shot.seconds, 0),
      nextShotNo: Math.max(
        record.nextShotNo ?? 1,
        ...record.shots.map((shot) => shot.no + 1),
        ...shots.map((shot) => shot.no + 1),
      ),
      videoPrompt: sequencePrompt(record, shots),
    })
  }

  async function patchBoard(id: string, patch: Partial<StoryboardRecord>): Promise<void> {
    const record = boardOf(id)
    if (record) await persist({ ...record, updatedAt: Date.now(), ...patch })
  }

  async function patchShot(id: string, no: number, patch: Partial<StoryboardShotRecord>) {
    const record = boardOf(id)
    if (!record) return
    await patchBoard(id, {
      shots: record.shots.map((shot) => (shot.no === no ? { ...shot, ...patch } : shot)),
    })
  }

  async function submitShotImage(
    record: StoryboardRecord,
    no: number,
    references: InputImage[],
  ): Promise<void> {
    const shot = record.shots.find((item) => item.no === no)
    if (!shot) return
    const [taskId] = await submitPrepared({
      prompt: shot.imagePrompt,
      inputImages: references,
      params: storyboardImageParams(useStore.getState().params, record.aspectRatio),
      origin: { setId: record.id, shotId: `shot-${no}`, kind: 'storyboard' },
    })
    if (!taskId) return
    await patchShot(record.id, no, { imageTaskId: taskId, imageId: null })
  }

  /** 取不出来的那张直接丢掉：分镜照样出，只是少一张参考。 */
  async function loadReferences(ids: readonly string[]): Promise<InputImage[]> {
    const loaded = await Promise.all(
      ids.map(async (id) => ({ id, dataUrl: await ensureImageCached(id) })),
    )
    return loaded.filter((one): one is InputImage => Boolean(one.dataUrl))
  }

  /** 逐条提交：每条都要单独过一次提交门禁，并按提交顺序排进工作台。 */
  async function submitShotImages(
    id: string,
    pick: (shot: StoryboardShotRecord) => boolean,
  ): Promise<void> {
    const record = boardOf(id)
    if (!record) return
    const references = await loadReferences(record.referenceImageIds)
    for (const shot of record.shots) {
      if (pick(shot)) await submitShotImage(record, shot.no, references)
    }
  }

  async function runPlan(
    input: StoryboardPlanInput,
    toRecord: (plan: StoryboardPlan) => StoryboardRecord,
  ): Promise<string | null> {
    set({ loadingSince: Date.now() })
    try {
      const references = (await loadReferences(input.referenceImageIds)).map((one) => one.dataUrl)
      const plan = await planStoryboard({
        idea: input.idea.trim(),
        shots: input.shots,
        totalSeconds: input.totalSeconds,
        aspectRatio: input.aspectRatio,
        ...(input.style === STORYBOARD_FREE_STYLE ? {} : { style: input.style }),
        ...(references.length > 0 ? { referenceImages: references } : {}),
      })
      const record = toRecord(plan)
      if (!(await persist(record))) return null
      set({ activeId: record.id })
      if (record.shotImagesRequested) await submitShotImages(record.id, () => true)
      return record.id
    } catch (err) {
      useStore.getState().showToast(errorMessage(err), 'error')
      return null
    } finally {
      set({ loadingSince: null })
    }
  }

  return {
    storyboards: [],
    activeId: null,
    loadingSince: null,
    draft: INITIAL_STORYBOARD_DRAFT,
    saveStates: {},
    loadError: null,

    async retrySave(id) {
      const record = boardOf(id)
      if (record) await persist(record)
    },
    rename(id, title) {
      return patchBoard(id, { title: title.trim() || '未命名分镜' })
    },
    async saveVersion(id, name) {
      const record = boardOf(id)
      if (!record) return null
      const versions = record.versions ?? []
      const version: StoryboardVersion = {
        id: crypto.randomUUID(),
        name: name.trim() || '未命名版本',
        number: versions.length + 1,
        savedAt: Date.now(),
        content: storyboardContent(record),
      }
      return (await persist({ ...record, versions: [...versions, version], updatedAt: Date.now() }))
        ? structuredClone(version)
        : null
    },
    async restoreVersion(id, versionId) {
      const record = boardOf(id)
      const version = record?.versions?.find((item) => item.id === versionId)
      if (!record || !version) return
      if (!sameStoryboard(storyboardContent(record), version.content)) {
        const backup = await get().saveVersion(id, '恢复前草稿')
        if (!backup) return
        const current = boardOf(id)
        if (!current || !sameStoryboard(storyboardContent(current), backup.content)) {
          useStore
            .getState()
            .showToast('草稿在恢复期间有新修改，已保留新修改，请重新选择恢复版本', 'error')
          return
        }
      }
      await patchBoard(id, { ...structuredClone(version.content), videoTaskId: null })
    },
    async moveShot(id, no, direction) {
      const record = boardOf(id)
      if (!record) return
      const index = record.shots.findIndex((shot) => shot.no === no)
      const target = index + direction
      if (index < 0 || target < 0 || target >= record.shots.length) return
      const shots = [...record.shots]
      ;[shots[index], shots[target]] = [shots[target]!, shots[index]!]
      await editSequence(record, shots)
    },
    async addShot(id, copyNo) {
      const record = boardOf(id)
      if (!record) return
      const origin = record.shots.find((shot) => shot.no === copyNo)
      const next: StoryboardShotRecord = {
        no: Math.max(record.nextShotNo ?? 1, ...record.shots.map((shot) => shot.no + 1)),
        title: origin ? `${origin.title} · 副本` : '新镜头',
        description: origin?.description ?? '',
        camera: origin?.camera ?? '固定镜头',
        line: origin?.line ?? '',
        seconds: origin?.seconds ?? 5,
        startSeconds: 0,
        imagePrompt: origin?.imagePrompt ?? '',
        videoPrompt: origin?.videoPrompt ?? '',
        imageId: origin?.imageId ?? null,
        imageTaskId: null,
        videoTaskId: null,
      }
      await editSequence(record, [...record.shots, next])
    },
    async removeShot(id, no) {
      const record = boardOf(id)
      if (record && record.shots.length > 1) {
        await editSequence(
          record,
          record.shots.filter((shot) => shot.no !== no),
        )
      }
    },

    async load() {
      try {
        const stored = byNewest(await storyboardStore.list())
        set((state) => ({
          storyboards: byNewest([
            ...stored.filter(
              (item) => !state.storyboards.some((current) => current.id === item.id),
            ),
            ...state.storyboards,
          ]),
          activeId: state.activeId ?? stored[0]?.id ?? null,
          loadError: null,
        }))
      } catch (err) {
        set({ loadError: `分镜读取失败：${errorMessage(err)}` })
      }
    },

    setIdea(idea) {
      set((state) => ({ draft: { ...state.draft, idea } }))
    },
    setShots(shots) {
      set((state) => ({ draft: { ...state.draft, shots } }))
    },
    setTotalSeconds(totalSeconds) {
      set((state) => ({ draft: { ...state.draft, totalSeconds } }))
    },
    setStyle(style) {
      set((state) => ({ draft: { ...state.draft, style } }))
    },
    setShotImages(shotImages) {
      set((state) => ({ draft: { ...state.draft, shotImages } }))
    },

    toggleReference(imageId) {
      const { referenceImageIds } = get().draft
      if (referenceImageIds.includes(imageId)) {
        get().removeReference(imageId)
        return
      }
      if (!roomForReference()) return
      set((state) => ({
        draft: { ...state.draft, referenceImageIds: [...state.draft.referenceImageIds, imageId] },
      }))
    },
    removeReference(imageId) {
      set((state) => ({
        draft: {
          ...state.draft,
          referenceImageIds: state.draft.referenceImageIds.filter((id) => id !== imageId),
        },
      }))
    },
    // 先问还装不装得下再落盘：拖进来十几张时，多余的会白白解码并永久留在 IndexedDB 里。
    async addReferencesFromFiles(files) {
      for (const file of files) {
        if (!roomForReference()) return
        const { id } = await storeImageFromFile(file)
        get().toggleReference(id)
      }
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
        totalSeconds: input.totalSeconds,
        videoPrompt: plan.videoPrompt,
        style: input.style,
        referenceImageIds: [...input.referenceImageIds],
        shotImagesRequested: input.shotImages,
        videoTaskId: null,
        shots: shotsFromPlan(plan),
      }))
    },

    replan(id) {
      const record = boardOf(id)
      if (!record) return Promise.resolve(null)
      // 重写生成新分镜，保留原稿及其版本。
      return runPlan(
        {
          ...record,
          shots: record.shots.length as StoryboardShotCount,
          totalSeconds: record.totalSeconds as StoryboardTotalSeconds,
          shotImages: record.shotImagesRequested,
        },
        (plan) => ({
          ...record,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          versions: [],
          updatedAt: Date.now(),
          title: plan.title,
          summary: plan.summary,
          videoPrompt: plan.videoPrompt,
          videoTaskId: null,
          shots: shotsFromPlan(plan),
        }),
      )
    },

    select(id) {
      set({ activeId: id })
    },

    async remove(id) {
      deleting.add(id)
      await writes.get(id)
      try {
        await storyboardStore.remove(id)
        set((state) => ({
          storyboards: state.storyboards.filter((item) => item.id !== id),
          activeId:
            state.activeId === id
              ? (state.storyboards.find((item) => item.id !== id)?.id ?? null)
              : state.activeId,
        }))
      } catch (err) {
        useStore.getState().showToast(`删除失败：${errorMessage(err)}`, 'error')
      } finally {
        deleting.delete(id)
      }
    },

    async updateShot(id, no, patch) {
      const record = boardOf(id)
      const shot = record?.shots.find((item) => item.no === no)
      if (!record || !shot) return
      const next = { ...shot, ...patch }
      if (
        patch.seconds !== undefined &&
        (!Number.isFinite(patch.seconds) || patch.seconds < 0.5 || patch.seconds > 30)
      )
        return
      if (
        patch.description !== undefined ||
        patch.camera !== undefined ||
        patch.line !== undefined
      ) {
        next.videoPrompt = patch.videoPrompt ?? shotPrompt(next)
        if (patch.description !== undefined)
          next.imagePrompt = `${record.summary}。${next.description}`
      }
      await editSequence(
        record,
        record.shots.map((item) => (item.no === no ? next : item)),
      )
    },

    updateVideoPrompt(id, videoPrompt) {
      return patchBoard(id, { videoPrompt })
    },

    async regenerateShotImage(id, no) {
      await patchShot(id, no, { imageTaskId: null, imageId: null })
      const record = boardOf(id)
      if (record) await submitShotImage(record, no, await loadReferences(record.referenceImageIds))
    },

    generateMissingShotImages(id) {
      return submitShotImages(id, (shot) => shot.imageTaskId === null)
    },

    async generateShotVideo(id, no) {
      const record = boardOf(id)
      const shot = record?.shots.find((item) => item.no === no)
      if (!record || !shot) return null
      if (!shot.imageId) {
        useStore.getState().showToast(NO_IMAGE, 'error')
        return null
      }
      const { model, resolution } = useVideoStore.getState().draft
      const version = await versionForGeneration(id)
      if (!version) return null
      const taskId = await useVideoStore.getState().submitFromStoryboard({
        storyboardVersion: version,
        model,
        resolution,
        storyboardId: id,
        shotNo: no,
        imageId: shot.imageId,
        prompt: shot.videoPrompt,
        seconds: shot.seconds,
        aspectRatio: record.aspectRatio,
      })
      if (taskId) await patchShot(id, no, { videoTaskId: taskId })
      return taskId
    },

    async generateWholeVideo(id) {
      const record = boardOf(id)
      if (!record) return null
      const { model, resolution } = useVideoStore.getState().draft
      const version = await versionForGeneration(id)
      if (!version) return null
      const taskId = await useVideoStore.getState().submitStoryboardVideo({
        storyboardVersion: version,
        model,
        resolution,
        storyboardId: id,
        imageId: wholeVideoFrameId(record),
        prompt: record.videoPrompt,
        seconds: record.totalSeconds,
        aspectRatio: record.aspectRatio,
      })
      if (taskId) await patchBoard(id, { videoTaskId: taskId })
      return taskId
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
