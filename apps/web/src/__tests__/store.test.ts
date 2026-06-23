import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultGeminiByokProfile,
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../lib/apiProfiles'
import { getSelectedImageMentionLabel } from '../lib/promptImageMentions'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('../lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})

import { clearImages, putImage } from '../lib/db'
import {
  editOutputImage,
  getPersistedState,
  getTaskApiProfile,
  markInterruptedOpenAIRunningTasks,
  reuseConfig,
  submitTask,
  useStore,
} from '../store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [createDefaultOpenAIByokProfile({ apiKey: 'test-key' })],
        activeProfileId: 'default-openai',
      }),
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('editOutputImage 对输出图打开遮罩编辑器且不破坏已有 mask draft', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    await putImage({ id: imageA.id, dataUrl: imageA.dataUrl, source: 'generated', createdAt: 1 })
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputImage(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskEditorImageId).toBe(imageA.id)
    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({
      id: 'legacy-running',
      status: 'running',
      createdAt: 1_000,
      finishedAt: null,
      elapsed: null,
    })
    const openAIRunning = task({
      id: 'openai-running',
      apiProvider: 'openai',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    const customAsyncRunning = task({
      id: 'custom-running',
      apiProvider: 'custom-provider',
      customTaskId: 'task-1',
      status: 'running',
      createdAt: 4_000,
      finishedAt: null,
      elapsed: null,
    })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks(
      [legacyRunning, openAIRunning, customAsyncRunning, doneTask],
      now,
    )

    expect(result.interruptedTasks.map((item) => item.id)).toEqual([
      'legacy-running',
      'openai-running',
    ])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: 'prompt',
      inputImages: [imageA],
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIByokProfile({
    id: 'openai-profile',
    apiKey: 'openai-key',
  })
  const geminiProfile = createDefaultGeminiByokProfile({
    id: 'gemini-profile',
    name: 'Gemini 配置',
    apiKey: 'gem-key',
  })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, geminiProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(
      useStore.getState().settings,
      task({ apiProvider: 'gemini', apiProfileId: geminiProfile.id }),
    )

    expect(resolved?.id).toBe(geminiProfile.id)
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(
      task({
        apiProvider: 'gemini',
        apiProfileId: geminiProfile.id,
        params: { ...DEFAULT_PARAMS, n: 1, size: 'auto', quality: 'auto' },
      }),
    )

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(geminiProfile.id)
    expect(state.params).toMatchObject({ n: 1, size: 'auto', quality: 'auto' })
    expect(state.showToast).toHaveBeenCalledWith(
      '已临时复用该任务的 API 配置「Gemini 配置」',
      'success',
    )
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(
      task({
        apiProvider: 'openai',
        apiProfileId: openaiProfile.id,
        prompt: taskPrompt,
        inputImageIds: [imageA.id, imageB.id],
      }),
    )

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'gemini', apiProfileId: geminiProfile.id }))

    useStore.getState().setSettings({ activeProfileId: geminiProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(geminiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(
      task({
        apiProvider: 'gemini',
        apiProfileId: geminiProfile.id,
        params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
      }),
    )

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'gemini', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '找不到 API 配置',
        message:
          '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
        confirmText: '使用当前配置提交',
        cancelText: '放弃提交',
      }),
    )
    expect(state.showSettings).toBe(false)
  })
})

describe('getPersistedState builtin profile stripping', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: '',
      inputImages: [],
      dismissedCodexCliPrompts: [],
    })
  })

  it('removes builtin-edge profiles before persisting', () => {
    const userProfile = createDefaultOpenAIByokProfile({ id: 'user-1', apiKey: 'user-key' })
    const builtinEdge = {
      id: 'test-x',
      source: 'builtin-edge' as const,
      channelId: 'test-x',
      selectedModelId: 'm',
    }
    useStore.setState({
      settings: normalizeSettings({
        profiles: [builtinEdge, userProfile],
        activeProfileId: userProfile.id,
      }),
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.settings.profiles.find((p) => p.id === 'test-x')).toBeUndefined()
    expect(persisted.settings.profiles.find((p) => p.id === 'user-1')).toBeDefined()
  })
})
