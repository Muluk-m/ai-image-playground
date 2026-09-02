import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultGeminiByokProfile,
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../lib/apiProfiles'
import { bootstrapClientCapabilities } from '../lib/clientCapabilities'
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

vi.mock('../lib/api', () => ({
  callImageApi: vi.fn(async () => ({
    images: ['data:image/png;base64,generated'],
    actualParamsList: [{ size: '1x1' }],
  })),
  resumeQueueImageApi: vi.fn(),
}))

vi.mock('../lib/transparentImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transparentImage')>()
  return {
    ...actual,
    removeKeyedBackgroundFromDataUrl: vi.fn(async (dataUrl: string) => `transparent:${dataUrl}`),
  }
})

import { callImageApi } from '../lib/api'
import { setChannels } from '../lib/channels/channelStore'
import type { BuiltinEdgeProfile, ClientProfile, PublicChannel } from '../lib/channels/types'
import { clearImages, getImage, putImage } from '../lib/db'
import { removeKeyedBackgroundFromDataUrl } from '../lib/transparentImage'
import {
  addCompletedCanvasTask,
  editOutputImage,
  getPersistedState,
  getTaskApiProfile,
  markInterruptedOpenAIRunningTasks,
  retryTask,
  reuseConfig,
  submitTask,
  useStore,
} from '../store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

async function waitUntil(predicate: () => boolean | undefined, message: string) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

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
  beforeEach(async () => {
    await bootstrapClientCapabilities(false, '')
    setChannels([])
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockResolvedValue(
      'transparent:data:image/png;base64,generated',
    )
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

  it('stores transparent background output after local post-processing', async () => {
    await clearImages()
    useStore.setState({
      prompt: 'single sticker',
      params: { ...DEFAULT_PARAMS, transparent_output: true },
    })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'done',
      'transparent task did not finish',
    )

    const generatedTask = useStore.getState().tasks[0]
    expect(callImageApi).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('#00FF00'),
        params: expect.objectContaining({
          output_format: 'png',
          output_compression: null,
          transparent_output: true,
          n: 1,
        }),
      }),
    )
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,generated')
    expect(generatedTask).toMatchObject({
      prompt: 'single sticker',
      params: expect.objectContaining({ transparent_output: true }),
      transparentOutput: true,
      transparentPrompt: expect.stringContaining('#FF00FF'),
      status: 'done',
    })
    expect(generatedTask.outputImages).toHaveLength(1)
    expect(generatedTask.transparentOriginalImages).toHaveLength(1)

    const outputImage = await getImage(generatedTask.outputImages[0])
    const originalImage = await getImage(generatedTask.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,generated')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,generated')
  })

  it('submits a billed multi-image request as one atomic BFF task', async () => {
    const channel: PublicChannel = {
      id: 'paid-openai',
      kind: 'openai-queue',
      label: 'Paid OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    setChannels([channel])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        'accounts:login': true,
        'accounts:self-register': true,
        'billing:credits': true,
        'generation:byok': false,
        'quota:daily': false,
      }),
    )
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
    vi.mocked(callImageApi).mockResolvedValue({
      images: [
        'data:image/png;base64,one',
        'data:image/png;base64,two',
        'data:image/png;base64,three',
      ],
      actualParamsList: [{ size: '1x1' }, { size: '1x1' }, { size: '1x1' }],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: channel.id,
            source: 'builtin-edge',
            channelId: channel.id,
            selectedModelId: 'gpt-image-2',
          },
        ],
        activeProfileId: channel.id,
      }),
      prompt: 'three images',
      params: { ...DEFAULT_PARAMS, n: 3 },
    })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'done',
      'billed multi-image task did not finish',
    )

    expect(callImageApi).toHaveBeenCalledTimes(1)
    expect(callImageApi).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ n: 3 }) }),
    )
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0]?.outputImages).toHaveLength(3)
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
      slotValues: { 背景: ['浴室'] },
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists slot values with the rest of the input', () => {
    expect(getPersistedState(useStore.getState()).slotValues).toEqual({ 背景: ['浴室'] })

    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })
    expect(getPersistedState(useStore.getState())).not.toHaveProperty('slotValues')
  })

  it('keeps slot values whose slot left the prompt, so retyping it restores them', () => {
    useStore.getState().setPrompt('没有槽位')

    expect(useStore.getState().slotValues).toEqual({ 背景: ['浴室'] })
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

describe('addCompletedCanvasTask', () => {
  beforeEach(() => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS }, tasks: [] })
  })

  it('输出图落 image store，任务以 done 状态插入历史', async () => {
    await addCompletedCanvasTask({
      prompt: 'canvas prompt',
      params: { ...DEFAULT_PARAMS, n: 1 },
      images: ['data:image/png;base64,one', 'data:image/png;base64,two'],
      elapsed: 1234,
    })

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(1)
    const record = tasks[0]
    expect(record.status).toBe('done')
    expect(record.prompt).toBe('canvas prompt')
    expect(record.outputImages).toHaveLength(2)
    expect(record.inputImageIds).toEqual([])
    expect(record.elapsed).toBe(1234)
    expect(record.finishedAt).not.toBeNull()
  })
})

describe('canvas image handoff queue', () => {
  beforeEach(() => {
    useStore.setState({ pendingCanvasImages: [] })
  })

  it('queue 追加、consume 返回并清空、二次 consume 为空', () => {
    const { queueCanvasImages, consumeCanvasImages } = useStore.getState()
    queueCanvasImages(['data:a', 'data:b'])
    expect(useStore.getState().pendingCanvasImages).toEqual(['data:a', 'data:b'])
    expect(consumeCanvasImages()).toEqual(['data:a', 'data:b'])
    expect(useStore.getState().pendingCanvasImages).toEqual([])
    expect(consumeCanvasImages()).toEqual([])
  })

  it('getPersistedState 不含 pendingCanvasImages（一次性 handoff 不持久化）', () => {
    useStore.getState().queueCanvasImages(['data:x'])
    const persisted = getPersistedState(useStore.getState())
    expect('pendingCanvasImages' in persisted).toBe(false)
  })
})

describe('submitTask 数量分发（capability n 门控）', () => {
  const gptImageChannel: PublicChannel = {
    id: 'openai-images',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [
      {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        capabilities: ['generate', 'edit', 'mask', 'quality', 'n'],
      },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }
  const geminiChannel: PublicChannel = {
    id: 'gemini-flash-image',
    kind: 'gemini-queue',
    label: 'Gemini',
    models: [
      {
        id: 'gemini-3.1-flash-image',
        label: 'Gemini 3.1 Flash Image',
        capabilities: ['generate', 'edit', 'size'],
      },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  function builtinProfile(channelId: string, modelId: string): BuiltinEdgeProfile {
    return {
      id: `builtin-${channelId}`,
      source: 'builtin-edge',
      channelId,
      selectedModelId: modelId,
    }
  }

  function setupCountState(profile: ClientProfile) {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS, n: 4 },
      tasks: [],
      detailTaskId: null,
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  }

  function expectFanOutFour() {
    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(4)
    expect(tasks.every((t) => t.params.n === 1)).toBe(true)
    expect(new Set(tasks.map((t) => t.clientRequestId)).size).toBe(4)
    const calls = vi.mocked(callImageApi).mock.calls
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c[0].params.n === 1)).toBe(true)
  }

  beforeEach(() => {
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
    setChannels([])
  })

  afterEach(() => {
    setChannels([])
  })

  it('声明 n 的内置模型：count=4 合并为一条任务、一次 submit 携带 n=4，多图全部落在这条任务上', async () => {
    setChannels([gptImageChannel])
    setupCountState(builtinProfile('openai-images', 'gpt-image-2'))
    vi.mocked(callImageApi).mockResolvedValue({
      images: [
        'data:image/png;base64,g1',
        'data:image/png;base64,g2',
        'data:image/png;base64,g3',
        'data:image/png;base64,g4',
      ],
      actualParamsList: [
        { size: '1024x1024' },
        { size: '1024x1024' },
        { size: '1024x1024' },
        { size: '1024x1024' },
      ],
    })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'done',
      'native count task did not finish',
    )

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].params.n).toBe(4)
    expect(tasks[0].clientRequestId).toBeTruthy()
    const calls = vi.mocked(callImageApi).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0].params.n).toBe(4)
    expect(tasks[0].outputImages).toHaveLength(4)
    expect(new Set(tasks[0].outputImages).size).toBe(4)
    expect(tasks[0].actualParams).toMatchObject({ n: 4 })
  })

  it('原生 n 任务重试仍是一条任务携带 n=4（native task 粒度）', async () => {
    setChannels([gptImageChannel])
    setupCountState(builtinProfile('openai-images', 'gpt-image-2'))
    const failed = task({
      id: 'native-failed',
      status: 'error',
      params: { ...DEFAULT_PARAMS, n: 4 },
      apiProvider: 'openai',
      apiProfileId: 'builtin-openai-images',
    })
    useStore.setState({ tasks: [failed] })

    await retryTask(failed)
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'done',
      'retried native task did not finish',
    )

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0].params.n).toBe(4)
    const calls = vi.mocked(callImageApi).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0].params.n).toBe(4)
  })

  it('未声明 n 的内置模型（Gemini）：count=4 保持四条任务、各自 n=1 且 clientRequestId 唯一', async () => {
    setChannels([geminiChannel])
    setupCountState(builtinProfile('gemini-flash-image', 'gemini-3.1-flash-image'))

    await submitTask()
    await waitUntil(
      () =>
        useStore.getState().tasks.length === 4 &&
        useStore.getState().tasks.every((t) => t.status === 'done'),
      'fan-out tasks did not finish',
    )

    expectFanOutFour()
  })

  it('BYOK profile（无能力声明，模型名与内置相同也不推断）：count=4 仍是四条 n=1 任务', async () => {
    setChannels([gptImageChannel])
    setupCountState(createDefaultOpenAIByokProfile({ apiKey: 'test-key' }))

    await submitTask()
    await waitUntil(
      () =>
        useStore.getState().tasks.length === 4 &&
        useStore.getState().tasks.every((t) => t.status === 'done'),
      'fan-out tasks did not finish',
    )

    expectFanOutFour()
  })
})

describe('submitTask 槽位批量展开', () => {
  function setupSlotState(prompt: string, slotValues: Record<string, string[]>, n: number) {
    const profile = createDefaultOpenAIByokProfile({ apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
        clearInputAfterSubmit: false,
      }),
      prompt,
      slotValues,
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS, n },
      tasks: [],
      detailTaskId: null,
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  }

  beforeEach(() => {
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
    setChannels([])
  })

  it('笛卡尔积展开为独立任务，每条提示词已替换且配置一致', async () => {
    setupSlotState('{场景}里的猫，{角度}', { 场景: ['浴室', '厨房'], 角度: ['正面', '俯视'] }, 1)

    await submitTask()

    const tasks = useStore.getState().tasks
    expect(tasks.map((t) => t.prompt)).toEqual([
      '浴室里的猫，正面',
      '浴室里的猫，俯视',
      '厨房里的猫，正面',
      '厨房里的猫，俯视',
    ])
    expect(new Set(tasks.map((t) => t.clientRequestId)).size).toBe(4)
    expect(tasks.every((t) => t.apiModel === tasks[0].apiModel)).toBe(true)
  })

  it('展开后每条再按现有 n 规则分发：M=2 × n=3 得到 6 条 n=1 任务', async () => {
    setupSlotState('{场景}里的猫', { 场景: ['浴室', '厨房'] }, 3)

    await submitTask()

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(6)
    expect(tasks.every((t) => t.params.n === 1)).toBe(true)
    expect(tasks.filter((t) => t.prompt === '浴室里的猫')).toHaveLength(3)
    expect(tasks.filter((t) => t.prompt === '厨房里的猫')).toHaveLength(3)
  })

  it('M × n 超过 16 张时不提交并提示', async () => {
    setupSlotState('{场景}', { 场景: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, 2)

    await submitTask()

    expect(useStore.getState().tasks).toHaveLength(0)
    expect(useStore.getState().showToast).toHaveBeenCalledWith('单次最多 16 张', 'error')
  })

  it('任一槽位无值时不提交并提示', async () => {
    setupSlotState('{场景}里的{角度}', { 场景: ['浴室'] }, 1)

    await submitTask()

    expect(useStore.getState().tasks).toHaveLength(0)
    expect(useStore.getState().showToast).toHaveBeenCalledWith('槽位 {角度} 未填值', 'error')
  })
})
