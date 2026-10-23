import { PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failTaskPuts = vi.hoisted(() => new Set<string>())

import type { AssetRecord, LookRecord, TemplateRecord } from '../features/library/types'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/apiProfiles'
import { bootstrapClientCapabilities } from '../lib/clientCapabilities'
import { API_MAX_IMAGES } from '../lib/inputImageLimit'
import { mergeHistory, type PlatformGenerationRow } from '../lib/platformGenerations'
import { getSelectedImageMentionLabel } from '../lib/promptImageMentions'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('../lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const generations = new Map<string, PlatformGenerationRow>()
  let imageSeq = 0
  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      if (failTaskPuts.has(task.id)) throw new Error('quota')
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
    getReferencedImageIds: async () => new Set<string>(),
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
    getCachedGenerations: async () => [...generations.values()],
    putCachedGeneration: async (row: PlatformGenerationRow) => {
      generations.set(row.id, row)
      return row.id
    },
    deleteCachedGeneration: async (id: string) => {
      generations.delete(id)
    },
  }
})

vi.mock('../features/library/lib/assetStore', () => {
  const assets = new Map<string, AssetRecord>()
  return {
    updateAssetRecord: async (
      id: string,
      change: (asset: AssetRecord) => AssetRecord,
      canWrite = () => true,
    ) => {
      const current = assets.get(id)
      if (!current || !canWrite()) return null
      const saved = change(current)
      assets.set(id, saved)
      return saved
    },
    assetStore: {
      list: async () => [...assets.values()],
      put: async (asset: AssetRecord) => {
        assets.set(asset.id, asset)
      },
      remove: async (id: string) => {
        assets.delete(id)
      },
    },
  }
})

vi.mock('../features/library/lib/templateStore', () => {
  const templates = new Map<string, TemplateRecord>()
  return {
    templateStore: {
      list: async () => [...templates.values()],
      put: async (template: TemplateRecord) => {
        templates.set(template.id, template)
      },
      remove: async (id: string) => {
        templates.delete(id)
      },
    },
  }
})

vi.mock('../features/library/lib/lookStore', () => {
  const looks = new Map<string, LookRecord>()
  return {
    lookImageIds: (look: LookRecord) => [...look.referenceImageIds],
    lookStore: {
      list: async () => [...looks.values()],
      listChanges: async () => [...looks.values()],
      applyRemote: async () => {},
      put: async (look: LookRecord) => {
        looks.set(look.id, look)
      },
      remove: async (id: string) => {
        looks.delete(id)
      },
    },
  }
})

// 私有 overlay 存在时，计费门禁会因为没有账号快照而拦下提交；本文件只测公开 store 行为。
const getPrivateSubmissionGuard = vi.hoisted(() => vi.fn(() => ({ blocked: false })))

vi.mock('../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/privateOverlay')>()),
  getPrivateSubmissionGuard,
}))

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

// jsdom 之外没有 canvas：遮罩覆盖度由用例指定，其余图片工具照旧。
const validateMaskMatchesImage = vi.hoisted(() =>
  vi.fn(async (): Promise<'empty' | 'partial' | 'full'> => 'partial'),
)
vi.mock('../lib/canvasImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/canvasImage')>()),
  validateMaskMatchesImage,
}))

const readRemoteGeneration = vi.hoisted(() => vi.fn())
vi.mock('../lib/remoteGenerations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/remoteGenerations')>()),
  readRemoteGeneration,
}))

import { IDBFactory } from 'fake-indexeddb'
import { setSignedIn, subscribeLoginPrompt } from '../auth/loginPrompt'
import { resumePendingSubmission } from '../auth/resumePendingSubmission'
import { useLibraryStore } from '../features/library/store'
import { callImageApi, resumeQueueImageApi } from '../lib/api'
import { resetChannelDiscoveryForTests } from '../lib/channels/bootstrapChannels'
import { resetChannelCatalog, setChannels } from '../lib/channels/channelStore'
import type { BuiltinEdgeProfile, ClientProfile, PublicChannel } from '../lib/channels/types'
import * as database from '../lib/db'
import {
  clearImages,
  clearTasks,
  getAllImages,
  getAllTasks,
  getImage,
  putImage,
  putTask,
} from '../lib/db'
import { _setRuntimeConfigForTesting } from '../lib/runtimeConfig'
import { dismissSubmittedTasks, submittedTaskSnapshot } from '../lib/submittedTaskAttention'
import { taskCancelled } from '../lib/taskError'
import { removeKeyedBackgroundFromDataUrl } from '../lib/transparentImage'
import {
  addCompletedCanvasTask,
  confirmDialogAsync,
  editOutputImage,
  getPersistedState,
  getTaskApiProfile,
  initStore,
  markInterruptedOpenAIRunningTasks,
  materializeRemoteTask,
  retryTask,
  reuseConfig,
  submitPrepared,
  submitTask,
  useStore,
} from '../store'
import { allCapabilitiesOff } from './fixtures/capabilities'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

async function waitUntil(predicate: () => boolean | undefined, message: string) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

function stubSessionStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
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
    // 登录态是模块级的，逐用例归零。
    setSignedIn(false)
    setChannels([
      {
        id: 'default-openai',
        kind: 'openai-queue',
        label: 'OpenAI',
        models: [
          {
            id: 'gpt-image-2',
            label: 'GPT Image 2',
            capabilities: ['generate', 'edit', 'mask', 'quality'],
          },
        ],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
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
        profiles: [
          {
            id: 'default-openai',
            source: 'builtin-edge',
            channelId: 'default-openai',
            selectedModelId: 'gpt-image-2',
          },
        ],
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

  afterEach(() => {
    setChannels([])
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

  it('模型不认参考图时，条里已有的那张输出图也不给开遮罩编辑器', async () => {
    const channel: PublicChannel = {
      id: 'no-edit',
      kind: 'openai-queue',
      label: 'NoEdit',
      models: [{ id: 'gen-only', label: 'Gen only', capabilities: ['generate'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    setChannels([channel])
    await putImage({ id: imageA.id, dataUrl: imageA.dataUrl, source: 'generated', createdAt: 1 })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: 'builtin-no-edit',
            source: 'builtin-edge',
            channelId: 'no-edit',
            selectedModelId: 'gen-only',
          },
        ],
        activeProfileId: 'builtin-no-edit',
      }),
      inputImages: [imageA],
    })

    await editOutputImage(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskEditorImageId).toBeNull()
    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      expect.stringContaining('不支持参考图'),
      'error',
    )
  })

  it('参考图条满了就不让改图，也不往条里塞第 17 张', async () => {
    await putImage({ id: 'output-x', dataUrl: imageA.dataUrl, source: 'generated', createdAt: 1 })
    useStore.setState({
      inputImages: Array.from({ length: API_MAX_IMAGES }, (_, index) => ({
        id: `filler-${index}`,
        dataUrl: imageA.dataUrl,
      })),
    })

    await editOutputImage(task({ outputImages: ['output-x'] }))

    expect(useStore.getState().inputImages).toHaveLength(API_MAX_IMAGES)
    expect(useStore.getState().maskEditorImageId).toBeNull()
    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      expect.stringContaining('已达上限'),
      'error',
    )
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
    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      '遮罩主图已不存在，请重新选择遮罩区域',
      'error',
    )
    expect(callImageApi).not.toHaveBeenCalled()
  })

  describe('composer 提交的遮罩校验只在 submitPrepared 一处', () => {
    const mask = 'data:image/png;base64,mask'
    const maskOnA = { targetImageId: imageA.id, maskDataUrl: mask, updatedAt: 1 }
    const maskImages = async () => (await getAllImages()).filter((img) => img.source === 'mask')

    beforeEach(async () => {
      await clearImages()
      validateMaskMatchesImage.mockClear()
      useStore.setState({
        appMode: 'image',
        setConfirmDialog: (confirmDialog) => useStore.setState({ confirmDialog }),
      })
    })

    it('提示词为空时先报提示词，不写遮罩图也不弹整幅确认', async () => {
      validateMaskMatchesImage.mockResolvedValueOnce('full')
      useStore.setState({ prompt: '  ', inputImages: [imageA], maskDraft: maskOnA })

      await submitTask()

      expect(useStore.getState().showToast).toHaveBeenCalledWith('请输入提示词', 'error')
      expect(validateMaskMatchesImage).not.toHaveBeenCalled()
      expect(useStore.getState().confirmDialog).toBeNull()
      expect(await maskImages()).toEqual([])
      expect(useStore.getState().maskDraft).toEqual(maskOnA)
    })

    it('整幅遮罩确认后发出的是点击时的快照', async () => {
      validateMaskMatchesImage.mockResolvedValueOnce('full')
      useStore.setState({ prompt: 'repaint the sky', inputImages: [imageA], maskDraft: maskOnA })

      const submitting = submitTask()
      await waitUntil(() => Boolean(useStore.getState().confirmDialog), 'no full-mask confirm')
      expect(validateMaskMatchesImage).toHaveBeenCalledOnce()
      useStore.setState({ prompt: 'a later draft', inputImages: [imageB], maskDraft: null })
      useStore.getState().confirmDialog?.action()
      await submitting

      await waitUntil(() => vi.mocked(callImageApi).mock.calls.length === 1, 'not submitted')
      expect(vi.mocked(callImageApi).mock.calls[0]?.[0]).toMatchObject({
        prompt: 'repaint the sky',
        inputImageDataUrls: [imageA.dataUrl],
        maskDataUrl: mask,
      })
      expect(useStore.getState().confirmDialog).toBeNull()
      expect(await maskImages()).toHaveLength(1)
    })

    it('取消整幅确认：不发请求，也不写遮罩图', async () => {
      validateMaskMatchesImage.mockResolvedValueOnce('full')
      useStore.setState({ prompt: 'repaint the sky', inputImages: [imageA], maskDraft: maskOnA })

      const submitting = submitTask()
      await waitUntil(() => Boolean(useStore.getState().confirmDialog), 'no full-mask confirm')
      useStore.getState().confirmDialog?.cancelAction?.()
      await submitting

      expect(callImageApi).not.toHaveBeenCalled()
      expect(useStore.getState().tasks).toEqual([])
      expect(await maskImages()).toEqual([])
      expect(useStore.getState().prompt).toBe('repaint the sky')
    })

    it('确认期间离开工作台：确认框收起，这次提交作废', async () => {
      validateMaskMatchesImage.mockResolvedValueOnce('full')
      useStore.setState({ prompt: 'repaint the sky', inputImages: [imageA], maskDraft: maskOnA })

      const submitting = submitTask()
      await waitUntil(() => Boolean(useStore.getState().confirmDialog), 'no full-mask confirm')
      useStore.setState({ appMode: 'canvas' })
      await submitting

      expect(useStore.getState().confirmDialog).toBeNull()
      expect(callImageApi).not.toHaveBeenCalled()
      expect(await maskImages()).toEqual([])
    })
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
        ...allCapabilitiesOff(),
        'accounts:login': true,
        'accounts:self-register': true,
        'billing:credits': true,
      }),
    )
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
    // 计费部署上提交要账号：这条用例测的是登录用户那条路。
    setSignedIn(true)
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

  it('未登录访客提交内置渠道：只弹一次登录框，不落任务行', async () => {
    const channel: PublicChannel = {
      id: 'paid-openai',
      kind: 'openai-queue',
      label: 'Paid OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    setChannels([channel])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ...allCapabilitiesOff(), 'accounts:login': true }))
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
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
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS },
    })
    vi.stubGlobal('indexedDB', new IDBFactory())
    stubSessionStorage()
    // 这个文件跑在 node 环境里，登录框事件要有个 window 才发得出去。
    vi.stubGlobal('window', new EventTarget())
    const prompted = vi.fn()
    const unsubscribe = subscribeLoginPrompt(prompted)

    try {
      await submitTask()
    } finally {
      unsubscribe()
      vi.unstubAllGlobals()
    }

    expect(prompted.mock.calls).toEqual([['gated-action']])
    expect(callImageApi).not.toHaveBeenCalled()
    expect(useStore.getState().tasks).toEqual([])
    // 弹窗就是反馈，不再叠一条报错。
    expect(useStore.getState().showToast).not.toHaveBeenCalled()
  })

  it('sends the original prompt once after login, not a later draft', async () => {
    const channel: PublicChannel = {
      id: 'paid-openai',
      kind: 'openai-queue',
      label: 'Paid OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    setChannels([channel])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ...allCapabilitiesOff(), 'accounts:login': true }))
    await bootstrapClientCapabilities(true, '')
    fetchMock.mockRestore()
    vi.stubGlobal('indexedDB', new IDBFactory())
    stubSessionStorage()
    vi.stubGlobal('window', new EventTarget())
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
      prompt: 'the original cat',
      inputImages: [],
      params: { ...DEFAULT_PARAMS },
    })
    try {
      await submitTask()
      expect(useStore.getState().tasks).toEqual([])
      useStore.setState({ prompt: 'a later dog', inputImages: [] })
      setSignedIn(true)
      await resumePendingSubmission()
      await waitUntil(
        () => vi.mocked(callImageApi).mock.calls.length === 1,
        'original submission was not sent',
      )
      const resumed = useStore.getState().tasks.find((item) => item.prompt === 'the original cat')
      expect(resumed).toBeTruthy()
      expect(submittedTaskSnapshot()).not.toContain(resumed?.id)
      expect(vi.mocked(callImageApi).mock.calls[0]?.[0]).toMatchObject({
        prompt: 'the original cat',
        inputImageDataUrls: [],
      })
      await resumePendingSubmission()
      expect(callImageApi).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('排队中被取消：卡片记成已取消，不自动弹出失败详情', async () => {
    vi.mocked(callImageApi).mockRejectedValue(taskCancelled('任务已取消'))
    useStore.setState({ prompt: 'a red cat', params: { ...DEFAULT_PARAMS }, detailTaskId: null })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'error',
      'cancelled task did not settle',
    )

    expect(useStore.getState().tasks[0]?.cancelled).toBe(true)
    expect(useStore.getState().detailTaskId).toBeNull()
  })

  it('把自己挂的超时 abort 写成超时文案，不把浏览器那句「用户取消了」甩给用户', async () => {
    vi.mocked(callImageApi).mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError'),
    )
    useStore.setState({ prompt: 'a red cat', params: { ...DEFAULT_PARAMS } })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks[0]?.status === 'error',
      'aborted task did not fail',
    )

    const failed = useStore.getState().tasks[0]
    expect(failed?.error).toContain('请求超时')
    expect(failed?.error).not.toContain('aborted')
  })
})

describe('参考图条的挪动、删除与整条换掉', () => {
  const imageC = { id: 'image-c', dataUrl: 'data:image/png;base64,c' }
  const maskOn = (targetImageId: string) => ({
    targetImageId,
    maskDataUrl: 'data:image/png;base64,mask',
    updatedAt: 1,
  })

  beforeEach(() => {
    useStore.setState({
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      showToast: vi.fn(),
    })
  })

  it('挪动一张图，提示词里的引用跟着图走', () => {
    useStore.setState({
      inputImages: [imageA, imageB, imageC],
      prompt: `${getSelectedImageMentionLabel(0)} 与 ${getSelectedImageMentionLabel(2)}`,
    })

    useStore.getState().moveInputImage(2, 0)

    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([
      imageC.id,
      imageA.id,
      imageB.id,
    ])
    expect(useStore.getState().prompt).toBe(
      `${getSelectedImageMentionLabel(1)} 与 ${getSelectedImageMentionLabel(0)}`,
    )
  })

  it('遮罩主图钉在第一位：它自己挪不动，别的图也插不到它前面', () => {
    useStore.setState({ inputImages: [imageA, imageB], maskDraft: maskOn(imageA.id) })

    useStore.getState().moveInputImage(0, 2)
    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])

    useStore.getState().moveInputImage(1, 0)
    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
  })

  it('删掉遮罩主图：遮罩草稿与编辑器一起收走，指向它的引用降级为一段文字', () => {
    useStore.setState({
      inputImages: [imageA, imageB],
      maskDraft: maskOn(imageA.id),
      maskEditorImageId: imageA.id,
      prompt: `${getSelectedImageMentionLabel(0)} 与 ${getSelectedImageMentionLabel(1)}`,
    })

    useStore.getState().removeInputImage(0)

    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageB.id])
    expect(useStore.getState().prompt).toBe(`@已移除图片 与 ${getSelectedImageMentionLabel(0)}`)
    expect(useStore.getState().maskDraft).toBeNull()
    expect(useStore.getState().maskEditorImageId).toBeNull()
  })

  it('整条换掉：遮罩主图还在就钉回第一位，不在就把遮罩一起丢掉', () => {
    useStore.setState({
      inputImages: [imageA, imageB],
      maskDraft: maskOn(imageB.id),
      maskEditorImageId: imageB.id,
    })

    useStore.getState().replaceInputImages([imageA, imageB])

    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageB.id, imageA.id])
    expect(useStore.getState().maskDraft?.targetImageId).toBe(imageB.id)

    useStore.getState().replaceInputImages([imageC])

    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageC.id])
    expect(useStore.getState().maskDraft).toBeNull()
    expect(useStore.getState().maskEditorImageId).toBeNull()
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('interrupts running tasks that cannot be resumed, including old custom-provider tasks', () => {
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
      'custom-running',
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
    expect(result.tasks.find((item) => item.id === 'custom-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('自带密钥'),
      customRecoverable: false,
      finishedAt: now,
    })
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })

  it('marks a stored bring-your-own-key task unrecoverable and still resumes a platform task', () => {
    const now = 10_000
    const byok = task({
      id: 'byok-sync',
      apiProvider: 'openai',
      apiProfileId: 'default-openai',
      clientRequestId: 'old-byok-key',
      status: 'running',
      createdAt: 1_000,
      finishedAt: null,
      elapsed: null,
    })
    const platform = task({
      id: 'platform-running',
      apiProvider: 'openai',
      apiProfileId: 'default-openai',
      bffRequestId: 'req-platform',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    const inflight = task({
      id: 'platform-inflight',
      apiProvider: 'openai',
      apiProfileId: 'default-openai',
      clientRequestId: 'idempotent-key',
      platformTask: true,
      status: 'running',
      createdAt: 3_000,
      finishedAt: null,
      elapsed: null,
    })

    const result = markInterruptedOpenAIRunningTasks([byok, platform, inflight], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['byok-sync'])
    expect(result.tasks.find((item) => item.id === 'byok-sync')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('自带密钥'),
    })
    expect(result.tasks.find((item) => item.id === 'platform-running')?.status).toBe('running')
    expect(result.tasks.find((item) => item.id === 'platform-inflight')?.status).toBe('running')
  })
})

describe('startup task migration', () => {
  const channel: PublicChannel = {
    id: 'default-openai',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  beforeEach(async () => {
    failTaskPuts.clear()
    await clearTasks()
    setChannels([channel])
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
      tasks: [],
    })
  })

  it('continues platform recovery when retiring an old task cannot be written', async () => {
    const byok = task({
      id: 'fail-write-byok',
      apiProvider: 'openai',
      apiProfileId: 'default-openai',
      clientRequestId: 'old-byok-key',
      status: 'running',
      createdAt: 1_000,
      finishedAt: null,
      elapsed: null,
    })
    const platform = task({
      id: 'platform-running',
      apiProvider: 'openai',
      apiProfileId: channel.id,
      apiModel: 'gpt-image-2',
      bffRequestId: 'req-platform',
      prompt: 'keep going',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    await putTask(byok)
    await putTask(platform)
    failTaskPuts.add(byok.id)
    vi.mocked(callImageApi).mockClear()
    vi.mocked(resumeQueueImageApi).mockReset()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await initStore()
      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('failed to persist')),
      ).toBe(true)
    } finally {
      errorSpy.mockRestore()
      failTaskPuts.clear()
    }

    expect(vi.mocked(callImageApi)).not.toHaveBeenCalled()
    expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'keep going' }),
      'req-platform',
    )
    expect(useStore.getState().tasks.find((item) => item.id === byok.id)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('自带密钥'),
    })
  })
})

describe('startup resume waits for the channel catalog', () => {
  const gemini: PublicChannel = {
    id: 'gemini-images',
    kind: 'gemini-queue',
    label: 'Gemini',
    models: [{ id: 'gemini-image', label: 'Gemini', capabilities: ['generate'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  afterEach(() => {
    resetChannelDiscoveryForTests()
    setChannels([])
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
    vi.unstubAllGlobals()
  })

  it('keeps a running platform task until the catalog arrives, then resumes it', async () => {
    resetChannelCatalog()
    _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
    await clearTasks()
    const running = task({
      id: 'gemini-running',
      apiProvider: 'gemini',
      apiProfileId: gemini.id,
      apiModel: 'gemini-image',
      bffRequestId: 'req-gemini',
      prompt: 'resume later',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    await putTask(running)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: gemini.id,
            source: 'builtin-edge',
            channelId: gemini.id,
            selectedModelId: 'gemini-image',
          },
        ],
        activeProfileId: gemini.id,
      }),
      tasks: [],
    })
    vi.mocked(resumeQueueImageApi).mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    )
    try {
      await initStore()
      await vi.waitFor(() => expect(warn).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))
      const stored = useStore.getState().tasks.find((item) => item.id === running.id)
      expect(stored).toMatchObject({ status: 'running', error: null })
      expect(vi.mocked(resumeQueueImageApi)).not.toHaveBeenCalled()

      setChannels([gemini])

      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'resume later' }),
        'req-gemini',
      )
      expect(
        useStore.getState().tasks.find((item) => item.id === running.id)?.error ?? '',
      ).not.toContain('API 配置')
    } finally {
      warn.mockRestore()
    }
  })

  async function bootOfflineCatalog(running: TaskRecord) {
    resetChannelCatalog()
    _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
    await clearTasks()
    await putTask(running)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: gemini.id,
            source: 'builtin-edge',
            channelId: gemini.id,
            selectedModelId: 'gemini-image',
          },
        ],
        activeProfileId: gemini.id,
      }),
      tasks: [],
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
    })
    vi.mocked(callImageApi).mockClear()
    vi.mocked(resumeQueueImageApi).mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    )
    await initStore()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    return warn
  }

  it('submits a new task once and resumes only the startup task when the catalog arrives', async () => {
    const running = task({
      id: 'gemini-running',
      apiProvider: 'gemini',
      apiProfileId: gemini.id,
      apiModel: 'gemini-image',
      bffRequestId: 'req-gemini',
      prompt: 'resume later',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    const generated = {
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    }
    let releaseSubmit: (value: typeof generated) => void = () => {}
    vi.mocked(callImageApi).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve
        }),
    )
    const warn = await bootOfflineCatalog(running)
    try {
      useStore.setState({ prompt: 'fresh idea' })
      const submitting = submitTask()
      await vi.waitFor(() => expect(vi.mocked(callImageApi)).toHaveBeenCalledTimes(1))
      expect(useStore.getState().tasks.find((item) => item.prompt === 'fresh idea')).toMatchObject({
        status: 'running',
        platformTask: true,
      })
      expect(vi.mocked(resumeQueueImageApi)).not.toHaveBeenCalled()

      setChannels([gemini])

      expect(vi.mocked(callImageApi)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(callImageApi).mock.calls[0]?.[0]).toMatchObject({ prompt: 'fresh idea' })
      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'resume later' }),
        'req-gemini',
      )

      releaseSubmit(generated)
      await submitting
      await waitUntil(
        () =>
          useStore.getState().tasks.find((item) => item.id === running.id)?.status !== 'running',
        'startup task did not finish resuming',
      )
      expect(vi.mocked(callImageApi)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledTimes(1)
    } finally {
      releaseSubmit(generated)
      warn.mockRestore()
      vi.mocked(callImageApi).mockImplementation(async () => generated)
      vi.mocked(resumeQueueImageApi).mockReset()
    }
  })

  it('runs one recovery when the same task is resumed twice', async () => {
    const running = task({
      id: 'gemini-running',
      apiProvider: 'gemini',
      apiProfileId: gemini.id,
      apiModel: 'gemini-image',
      bffRequestId: 'req-gemini',
      prompt: 'resume later',
      status: 'running',
      createdAt: 2_000,
      finishedAt: null,
      elapsed: null,
    })
    const generated = {
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    }
    let releaseResume: (value: typeof generated) => void = () => {}
    vi.mocked(resumeQueueImageApi).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseResume = resolve
        }),
    )
    const warn = await bootOfflineCatalog(running)
    try {
      setChannels([gemini])
      setChannels([gemini])

      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(callImageApi)).not.toHaveBeenCalled()

      releaseResume(generated)
      await waitUntil(
        () =>
          useStore.getState().tasks.find((item) => item.id === running.id)?.status !== 'running',
        'startup task did not finish resuming',
      )
      expect(vi.mocked(resumeQueueImageApi)).toHaveBeenCalledTimes(1)
    } finally {
      releaseResume(generated)
      warn.mockRestore()
      vi.mocked(resumeQueueImageApi).mockReset()
    }
  })
})

describe('saved creation selections before the channel catalog loads', () => {
  it('keeps the saved model and parameters until the catalog settles', () => {
    resetChannelCatalog()
    useStore.setState({
      createTarget: 'generate',
      settings: { ...DEFAULT_SETTINGS, profiles: [], activeProfileId: '' },
      creationSelections: {
        chat: {
          params: { ...DEFAULT_PARAMS, size: '1280x720', n: 2 },
          profileId: 'openai-images',
          model: 'gpt-image-2.5-sunburst',
        },
      },
      params: { ...DEFAULT_PARAMS },
    })

    useStore.getState().setCreateTarget('chat')

    expect(useStore.getState().creationSelections.chat).toMatchObject({
      profileId: 'openai-images',
      model: 'gpt-image-2.5-sunburst',
    })
    expect(useStore.getState().params).toMatchObject({ size: '1280x720', n: 2 })
  })

  it('drops a saved profile that is gone once the catalog has loaded', () => {
    setChannels([
      {
        id: 'openai-images',
        kind: 'openai-queue',
        label: 'OpenAI',
        models: [{ id: 'gpt-image-2.5-flare', label: 'Flare', capabilities: ['generate'] }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    useStore.setState({
      createTarget: 'generate',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: 'openai-images',
            source: 'builtin-edge',
            channelId: 'openai-images',
            selectedModelId: 'gpt-image-2.5-flare',
          },
        ],
        activeProfileId: 'openai-images',
      }),
      creationSelections: {
        chat: {
          params: { ...DEFAULT_PARAMS, size: '1280x720', n: 2 },
          profileId: 'missing-byok',
          model: 'gpt-image-2',
        },
      },
    })

    useStore.getState().setCreateTarget('chat')

    expect(useStore.getState().creationSelections.chat).toBeUndefined()
    expect(useStore.getState().params.size).toBe('1024x1024')
  })
})

describe('the persisted app mode', () => {
  function merge(persisted: Record<string, unknown>) {
    return useStore.persist
      .getOptions()
      .merge?.({ settings: { ...DEFAULT_SETTINGS }, ...persisted }, useStore.getState()) as {
      appMode: string
    }
  }

  it('opens the workbench instead of a saved page', () => {
    useStore.setState({ appMode: 'image' })
    expect(merge({ appMode: 'product' }).appMode).toBe('image')
  })

  it('does not undo navigation chosen before hydration finishes', () => {
    useStore.getState().setAppMode('canvas')
    expect(merge({ appMode: 'product' }).appMode).toBe('canvas')
  })

  it('does not save the current page for the next visit', () => {
    useStore.getState().setAppMode('image')
    expect(getPersistedState(useStore.getState())).not.toHaveProperty('appMode')
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: 'prompt',
      inputImages: [imageA],
      slotValues: { 背景: ['浴室'] },
    })
  })

  it('persists slot values with the rest of the input', () => {
    expect(getPersistedState(useStore.getState()).slotValues).toEqual({ 背景: ['浴室'] })

    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })
    expect(getPersistedState(useStore.getState())).not.toHaveProperty('slotValues')
  })

  it('drops persisted slot values that are not string arrays', () => {
    const merged = useStore.persist
      .getOptions()
      .merge?.(
        { settings: { ...DEFAULT_SETTINGS }, slotValues: { 背景: '浴室', 角度: ['正面', 3] } },
        useStore.getState(),
      ) as { slotValues: Record<string, string[]> }

    expect(merged.slotValues).toEqual({ 角度: ['正面'] })
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

  it('saved mask survives a reload with its reference image', async () => {
    const mask = 'data:image/png;base64,mask'
    useStore.getState().setMaskDraft({ targetImageId: imageA.id, maskDataUrl: mask, updatedAt: 1 })
    await waitUntil(() => Boolean(useStore.getState().maskDraft?.maskImageId), 'mask not stored')

    const persisted = getPersistedState(useStore.getState())
    const maskImageId = useStore.getState().maskDraft?.maskImageId
    expect(persisted.maskDraft).toEqual({
      targetImageId: imageA.id,
      maskDataUrl: '',
      maskImageId,
      updatedAt: 1,
    })

    await putImage({ id: imageA.id, dataUrl: imageA.dataUrl, createdAt: 1 })
    useStore.setState({ maskDraft: null, inputImages: [] })
    const merged = useStore.persist
      .getOptions()
      .merge?.(JSON.parse(JSON.stringify(persisted)), useStore.getState()) as {
      maskDraft: unknown
      inputImages: unknown
    }
    expect(merged.maskDraft).toBeNull()
    // 恢复完成前的写盘不能把待恢复的遮罩引用抹掉。
    expect(getPersistedState({ ...useStore.getState(), maskDraft: null }).maskDraft).toMatchObject({
      maskImageId,
    })
    useStore.setState({ inputImages: merged.inputImages as (typeof imageA)[], maskDraft: null })
    vi.stubGlobal('window', {})
    try {
      await initStore()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageA.id])
    expect(useStore.getState().maskDraft).toMatchObject({
      targetImageId: imageA.id,
      maskDataUrl: mask,
      maskImageId,
    })
  })

  it('恢复时目标图不在参考图条里的遮罩草稿直接丢弃，遮罩位图按孤图清掉', async () => {
    await putImage({ id: imageA.id, dataUrl: imageA.dataUrl, createdAt: 1 })
    await putImage({ id: 'orphan-mask', dataUrl: 'data:image/png;base64,m', createdAt: 1 })
    useStore.setState({ maskDraft: null, inputImages: [] })
    const merged = useStore.persist.getOptions().merge?.(
      {
        settings: { ...DEFAULT_SETTINGS },
        inputImages: [{ id: imageA.id, dataUrl: '' }],
        maskDraft: {
          targetImageId: 'gone-image',
          maskImageId: 'orphan-mask',
          maskDataUrl: '',
          updatedAt: 1,
        },
      },
      useStore.getState(),
    ) as { inputImages: (typeof imageA)[] }
    expect(getPersistedState({ ...useStore.getState(), maskDraft: null }).maskDraft).toBeNull()

    useStore.setState({ inputImages: merged.inputImages, maskDraft: null })
    vi.stubGlobal('window', {})
    try {
      await initStore()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(useStore.getState().maskDraft).toBeNull()
    expect(await getImage('orphan-mask')).toBeUndefined()
    expect(await getImage(imageA.id)).toBeDefined()
  })

  it('does not persist a mask when restart input restore is disabled', () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false },
      maskDraft: { targetImageId: imageA.id, maskDataUrl: 'm', updatedAt: 1, maskImageId: 'x' },
    })
    expect(getPersistedState(useStore.getState())).not.toHaveProperty('maskDraft')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('reusing a task', () => {
  const openaiProfile: BuiltinEdgeProfile = {
    id: 'openai-profile',
    source: 'builtin-edge',
    channelId: 'openai-profile',
    selectedModelId: 'gpt-image-2',
  }
  const geminiProfile: BuiltinEdgeProfile = {
    id: 'gemini-profile',
    source: 'builtin-edge',
    channelId: 'gemini-profile',
    selectedModelId: 'gemini-3.1-flash-image',
  }

  beforeEach(() => {
    setChannels([
      {
        id: 'openai-profile',
        kind: 'openai-queue',
        label: 'OpenAI',
        models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
      {
        id: 'gemini-profile',
        kind: 'gemini-queue',
        label: 'Gemini 配置',
        models: [
          {
            id: 'gemini-3.1-flash-image',
            label: 'Gemini',
            capabilities: ['generate', 'edit'],
          },
        ],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, geminiProfile],
        activeProfileId: openaiProfile.id,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
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

  it('restores params, prompt and input images under the current API profile', async () => {
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
        apiProvider: 'gemini',
        apiProfileId: geminiProfile.id,
        prompt: taskPrompt,
        inputImageIds: [imageA.id, imageB.id],
        params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
      }),
    )

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
    expect(state.prompt).toBe(taskPrompt)
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.showToast).toHaveBeenCalledWith('已复用配置到输入框', 'success')
  })

  it('reuses a task whose API profile is gone without prompting', async () => {
    await reuseConfig(
      task({
        apiProvider: 'gemini',
        apiProfileId: 'missing-profile',
        params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
      }),
    )

    const state = useStore.getState()
    expect(state.setConfirmDialog).not.toHaveBeenCalled()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })
})

describe('getPersistedState keeps platform profiles', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: '',
      inputImages: [],
    })
  })

  it('persists the platform profile and drops a retired BYOK record', () => {
    setChannels([
      {
        id: 'test-x',
        kind: 'openai-queue',
        label: 'X',
        models: [{ id: 'm', label: 'M', capabilities: ['generate'] }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    const builtinEdge = {
      id: 'test-x',
      source: 'builtin-edge' as const,
      channelId: 'test-x',
      selectedModelId: 'm',
    }
    useStore.setState({
      settings: normalizeSettings({
        profiles: [builtinEdge, { id: 'user-1', source: 'user-byok', apiKey: 'user-key' } as never],
        activeProfileId: 'user-1',
      }),
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.settings.profiles.map((profile) => profile.id)).toEqual(['test-x'])
    expect(persisted.settings.activeProfileId).toBe('test-x')
    expect(JSON.stringify(persisted.settings)).not.toContain('user-key')
    setChannels([])
  })
})

describe('addCompletedCanvasTask', () => {
  it('does not report a failed task write as persisted and allows the same completion to retry', async () => {
    const task = {
      id: 'canvas:storage-retry',
      prompt: 'retry',
      params: DEFAULT_PARAMS,
      images: ['data:image/png;base64,one'],
    }
    const saving = vi.spyOn(database, 'putTask').mockRejectedValueOnce(new Error('quota exceeded'))
    try {
      expect(await addCompletedCanvasTask(task)).toBe(false)
      expect(useStore.getState().tasks.some((t) => t.id === task.id)).toBe(false)
      expect(await addCompletedCanvasTask(task)).toBe(true)
      expect((await getAllTasks()).find((t) => t.id === task.id)?.outputImages).toHaveLength(1)
    } finally {
      saving.mockRestore()
    }
  })

  it('preserves favorites and original completion metadata on repeated delivery', async () => {
    const task = {
      id: 'canvas:favorite-job',
      prompt: 'original',
      params: DEFAULT_PARAMS,
      images: [],
      elapsed: 123,
    }
    await addCompletedCanvasTask(task)
    const original = { ...useStore.getState().tasks[0]!, isFavorite: true }
    useStore.getState().setTasks([original])
    await addCompletedCanvasTask({ ...task, prompt: 'late recovery', elapsed: 999 })
    expect(useStore.getState().tasks).toEqual([original])
  })

  it('upserts a recovered completion by its stable task identity', async () => {
    useStore.getState().setTasks([])
    const task = {
      id: 'canvas:same-job',
      prompt: 'two devices',
      params: DEFAULT_PARAMS,
      images: [],
    }
    await Promise.all([addCompletedCanvasTask(task), addCompletedCanvasTask(task)])
    expect(useStore.getState().tasks.filter((record) => record.id === task.id)).toHaveLength(1)
  })

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

  // 重试原本绕过了提交门禁、扇出与幂等键——三件事都归提交那条路，重试也得走同一条。
  it('重试按扇出规则拆：未声明 n 的渠道，n=4 的失败任务重试出四条 n=1', async () => {
    setChannels([geminiChannel])
    setupCountState(builtinProfile('gemini-flash-image', 'gemini-3.1-flash-image'))
    const failed = task({
      id: 'fanout-failed',
      status: 'error',
      params: { ...DEFAULT_PARAMS, n: 4 },
      apiProfileId: 'builtin-gemini-flash-image',
    })
    useStore.setState({ tasks: [failed] })

    await retryTask(failed)
    await waitUntil(() => vi.mocked(callImageApi).mock.calls.length === 4, 'retry did not fan out')

    const retried = useStore.getState().tasks.filter((t) => t.id !== failed.id)
    expect(retried).toHaveLength(4)
    expect(retried.every((t) => t.params.n === 1)).toBe(true)
    // 幂等键逐条唯一：共用一个键会被 BFF 去重折叠成一次生成。
    expect(new Set(retried.map((t) => t.clientRequestId)).size).toBe(4)
  })

  it('重试过提交门禁：门禁拦下就一条也不落，也不发请求', async () => {
    setChannels([gptImageChannel])
    setupCountState(builtinProfile('openai-images', 'gpt-image-2'))
    const failed = task({
      id: 'blocked-retry',
      status: 'error',
      apiProfileId: 'builtin-openai-images',
    })
    useStore.setState({ tasks: [failed] })
    getPrivateSubmissionGuard.mockReturnValueOnce({
      blocked: true,
      disabledReason: '积分不够了',
    } as never)

    await retryTask(failed)

    expect(useStore.getState().tasks).toEqual([failed])
    expect(callImageApi).not.toHaveBeenCalled()
    expect(useStore.getState().showToast).toHaveBeenCalledWith('积分不够了', 'error')
  })
})

describe('submitTask 槽位批量展开', () => {
  const slotChannel: PublicChannel = {
    id: 'slot-openai',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  function setupSlotState(prompt: string, slotValues: Record<string, string[]>, n: number) {
    setChannels([slotChannel])
    const profile: BuiltinEdgeProfile = {
      id: slotChannel.id,
      source: 'builtin-edge',
      channelId: slotChannel.id,
      selectedModelId: slotChannel.models[0].id,
    }
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

  beforeEach(async () => {
    await bootstrapClientCapabilities(false, '')
    setSignedIn(false)
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

describe('快速生成的逐张生成', () => {
  const channel: PublicChannel = {
    id: 'batch-openai',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit', 'n'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }
  const images = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `ref-${index + 1}`,
      dataUrl: `data:image/png;base64,ref${index + 1}`,
    }))

  async function setupBatchState(count: number, batchGenerate: boolean) {
    const db = await import('../lib/db')
    for (const image of images(count))
      await db.putImage({ ...image, source: 'upload', createdAt: Date.now() })
    setChannels([channel])
    const profile: BuiltinEdgeProfile = {
      id: channel.id,
      source: 'builtin-edge',
      channelId: channel.id,
      selectedModelId: channel.models[0].id,
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
        clearInputAfterSubmit: false,
      }),
      prompt: '换成纯白背景',
      slotValues: {},
      inputImages: images(count),
      maskDraft: null,
      params: { ...DEFAULT_PARAMS, n: 4 },
      batchGenerate,
      tasks: [],
      detailTaskId: null,
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  }

  beforeEach(async () => {
    await bootstrapClientCapabilities(false, '')
    setSignedIn(false)
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
  })

  afterEach(() => {
    setChannels([])
    useStore.setState({ batchGenerate: false })
  })

  it('每张参考图各发一条 n=1 的任务，只带自己那张图，同属一组', async () => {
    await setupBatchState(3, true)

    await submitTask()
    await waitUntil(
      () => vi.mocked(callImageApi).mock.calls.length === 3,
      'per-image requests were not sent',
    )

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.inputImageIds)).toEqual([['ref-1'], ['ref-2'], ['ref-3']])
    expect(tasks.every((t) => t.params.n === 1)).toBe(true)
    expect(new Set(tasks.map((t) => t.origin?.setId)).size).toBe(1)
    expect(tasks.map((t) => t.origin)).toEqual([
      expect.objectContaining({ kind: 'batch', shotId: '1' }),
      expect.objectContaining({ kind: 'batch', shotId: '2' }),
      expect.objectContaining({ kind: 'batch', shotId: '3' }),
    ])
    const calls = vi.mocked(callImageApi).mock.calls
    expect(calls.map((c) => c[0].inputImageDataUrls)).toEqual([
      ['data:image/png;base64,ref1'],
      ['data:image/png;base64,ref2'],
      ['data:image/png;base64,ref3'],
    ])
    expect(calls.every((c) => c[0].params.n === 1)).toBe(true)
  })

  it('整组出完只报一次总张数，不按每张报「已生成 1 张」', async () => {
    await setupBatchState(2, true)

    await submitTask()
    await waitUntil(
      () =>
        useStore.getState().tasks.length === 2 &&
        useStore.getState().tasks.every((t) => t.status === 'done'),
      'batch did not finish',
    )

    const doneToasts = vi
      .mocked(useStore.getState().showToast)
      .mock.calls.filter(([, type]) => type !== 'error')
    expect(doneToasts).toEqual([['生成完成，共 2 张图片', 'success']])
  })

  it('有失败时整组报已出几张、共几张；重试补齐后报全部', async () => {
    await setupBatchState(2, true)
    vi.mocked(callImageApi)
      .mockRejectedValueOnce(new Error('上游拒绝了这张图'))
      .mockResolvedValue({
        images: ['data:image/png;base64,generated'],
        actualParamsList: [{ size: '1x1' }],
      })

    await submitTask()
    await waitUntil(
      () =>
        useStore.getState().tasks.length === 2 &&
        useStore.getState().tasks.every((t) => t.status !== 'running'),
      'batch did not settle',
    )
    const showToast = vi.mocked(useStore.getState().showToast)
    expect(showToast.mock.calls).toEqual([['已生成 1/2 张，其余失败', 'info']])

    const failed = useStore.getState().tasks.find((t) => t.status === 'error')
    if (!failed) throw new Error('expected one failed item')
    showToast.mockClear()
    await retryTask(failed)
    await waitUntil(
      () => useStore.getState().tasks.filter((t) => t.status === 'done').length === 2,
      'retry did not finish',
    )
    expect(showToast.mock.calls).toEqual([['生成完成，共 2 张图片', 'success']])
  })

  it('同时最多发 5 张，其余排队，完成一张才发下一张', async () => {
    await setupBatchState(7, true)
    const gates: Array<() => void> = []
    vi.mocked(callImageApi).mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() =>
            resolve({
              images: ['data:image/png;base64,generated'],
              actualParamsList: [{ size: '1x1' }],
            }),
          )
        }),
    )

    await submitTask()
    await waitUntil(() => gates.length === 5, 'first five were not sent')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(callImageApi).mock.calls).toHaveLength(5)
    const queued = () => useStore.getState().tasks.filter((t) => t.batchQueued)
    expect(queued().map((t) => t.origin?.shotId)).toEqual(['6', '7'])

    gates[0]()
    await waitUntil(() => gates.length === 6, 'sixth was not sent after one finished')
    expect(queued().map((t) => t.origin?.shotId)).toEqual(['7'])

    for (let i = 1; i < 6; i++) gates[i]()
    await waitUntil(() => gates.length === 7, 'last was not sent')
    gates[6]()
    await waitUntil(
      () => useStore.getState().tasks.every((t) => t.status === 'done'),
      'batch did not finish',
    )
    expect(queued()).toHaveLength(0)
  })

  it('快速生成能分批加到 50 张，第 51 张按 50 张的上限拒绝', async () => {
    await setupBatchState(7, true)
    const more = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `more-${from + index}`,
        dataUrl: `data:image/png;base64,more${from + index}`,
      }))

    expect(useStore.getState().attachInputImages(more(8, 10))).not.toBeNull()
    expect(useStore.getState().attachInputImages(more(18, 33))).not.toBeNull()
    expect(useStore.getState().inputImages).toHaveLength(50)

    expect(useStore.getState().attachInputImages(more(51, 1))).toBeNull()
    expect(useStore.getState().inputImages).toHaveLength(50)
    expect(useStore.getState().showToast).toHaveBeenLastCalledWith(
      expect.stringContaining('50'),
      'error',
    )
  })

  it('没选逐张时多张图仍合并成一次参考', async () => {
    await setupBatchState(3, false)

    await submitTask()

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].inputImageIds).toEqual(['ref-1', 'ref-2', 'ref-3'])
    expect(tasks[0].origin).toBeUndefined()
  })

  it('超过模型一次能带的张数时只能逐张', async () => {
    await setupBatchState(20, false)

    await submitTask()

    expect(useStore.getState().tasks).toHaveLength(20)
  })

  it('失败的那张重试后留在原来那一组里，不弹详情', async () => {
    await setupBatchState(2, true)
    vi.mocked(callImageApi)
      .mockRejectedValueOnce(new Error('上游拒绝了这张图'))
      .mockResolvedValue({
        images: ['data:image/png;base64,generated'],
        actualParamsList: [{ size: '1x1' }],
      })

    await submitTask()
    await waitUntil(
      () => useStore.getState().tasks.every((t) => t.status !== 'running'),
      'batch did not settle',
    )
    const failed = useStore.getState().tasks.find((t) => t.status === 'error')
    if (!failed) throw new Error('expected one failed item')
    expect(useStore.getState().detailTaskId).toBeNull()

    const before = new Set(useStore.getState().tasks.map((t) => t.id))
    await retryTask(failed)

    const retried = useStore.getState().tasks.find((t) => !before.has(t.id))
    expect(retried?.origin).toEqual(failed.origin)
    expect(retried?.inputImageIds).toEqual(failed.inputImageIds)
  })
})

describe('素材引用与模板套用后提交', () => {
  const PANDA = 'data:image/png;base64,panda'
  const HALL = 'data:image/png;base64,hall'

  function setupState() {
    const channel: PublicChannel = {
      id: 'asset-openai',
      kind: 'openai-queue',
      label: 'OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    setChannels([channel])
    const profile: BuiltinEdgeProfile = {
      id: channel.id,
      source: 'builtin-edge',
      channelId: channel.id,
      selectedModelId: channel.models[0].id,
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
        clearInputAfterSubmit: false,
      }),
      prompt: '',
      slotValues: {},
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS, n: 1 },
      tasks: [],
      detailTaskId: null,
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  }

  async function attachNewAsset(imageId: string, dataUrl: string, name: string) {
    await putImage({ id: imageId, dataUrl, source: 'upload', createdAt: 0 })
    await useLibraryStore.getState().saveAsset(imageId, name)
    const asset = useLibraryStore
      .getState()
      .assets.find((a) => a.views.some((view) => view.imageId === imageId) && a.name === name)
    if (!asset) throw new Error('asset not saved')
    return useLibraryStore.getState().attachAsset(asset.id)
  }

  async function submittedPrompt() {
    await waitUntil(() => vi.mocked(callImageApi).mock.calls.length > 0, '未发出上游请求')
    return vi.mocked(callImageApi).mock.calls[0][0].prompt
  }

  beforeEach(async () => {
    await bootstrapClientCapabilities(false, '')
    setSignedIn(false)
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
    setChannels([])
    await clearImages()
    useLibraryStore.setState({ assets: [], templates: [] })
    setupState()
  })

  it('素材附加的参考图按序号发送为 [image N]', async () => {
    const index = await attachNewAsset('img-panda', PANDA, '熊猫')
    useStore.setState({ prompt: `把${getSelectedImageMentionLabel(index ?? 0)}放大` })

    await submitTask()

    expect(useStore.getState().inputImages).toHaveLength(1)
    expect(await submittedPrompt()).toBe('把[image 1]放大')
  })

  it('套用模板后引用按落位后的新序号发送', async () => {
    const panda = await attachNewAsset('img-panda', PANDA, '熊猫')
    useStore.setState({ prompt: `把${getSelectedImageMentionLabel(panda ?? 0)}放大` })
    await useLibraryStore.getState().saveTemplate('熊猫模板')
    const [template] = useLibraryStore.getState().templates

    // 这一张不经素材库进条，得自己先落进 image store，提交时才取得到字节。
    await putImage({ id: 'img-hall', dataUrl: HALL, source: 'upload', createdAt: 0 })
    useStore.setState({ inputImages: [{ id: 'img-hall', dataUrl: HALL }], prompt: '' })
    await useLibraryStore.getState().applyTemplate(template.id)
    await submitTask()

    expect(useStore.getState().inputImages.map((image) => image.id)).toEqual([
      'img-hall',
      'img-panda',
    ])
    expect(await submittedPrompt()).toBe('把[image 2]放大')
  })

  it('模板引用的素材已删除时仍能提交，引用降级为已移除', async () => {
    const panda = await attachNewAsset('img-panda', PANDA, '熊猫')
    useStore.setState({ prompt: `把${getSelectedImageMentionLabel(panda ?? 0)}放大` })
    await useLibraryStore.getState().saveTemplate('熊猫模板')
    const [template] = useLibraryStore.getState().templates
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().deleteAsset(asset.id)
    useStore.setState({ inputImages: [], prompt: '' })
    await useLibraryStore.getState().applyTemplate(template.id)
    await submitTask()

    expect(await submittedPrompt()).toBe('把@已移除图片放大')
  })
})

describe('素材与模板引导标记', () => {
  it('三个标记都进持久化状态', () => {
    useStore.setState({
      libraryCoachDismissed: true,
      libraryPanelOpened: true,
      assetHintShown: true,
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.libraryCoachDismissed).toBe(true)
    expect(persisted.libraryPanelOpened).toBe(true)
    expect(persisted.assetHintShown).toBe(true)
  })

  it('旧版本没写过这三个标记时读回 false', () => {
    useStore.setState({
      libraryCoachDismissed: true,
      libraryPanelOpened: true,
      assetHintShown: true,
    })

    const merged = useStore.persist
      .getOptions()
      .merge?.({ settings: { ...DEFAULT_SETTINGS } }, useStore.getState()) as {
      libraryCoachDismissed: boolean
      libraryPanelOpened: boolean
      assetHintShown: boolean
    }

    expect(merged.libraryCoachDismissed).toBe(false)
    expect(merged.libraryPanelOpened).toBe(false)
    expect(merged.assetHintShown).toBe(false)
  })
})

describe('submitPrepared 显式参数提交接缝', () => {
  const PREPARED_IMAGE = 'data:image/png;base64,prepared'
  const preparedOpenAI: PublicChannel = {
    id: 'default-openai',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [
      { id: 'gpt-image-1', label: 'GPT Image 1', capabilities: ['generate', 'edit'] },
      { id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }
  const preparedGemini: PublicChannel = {
    id: 'gemini-byok',
    kind: 'gemini-queue',
    label: 'Gemini',
    models: [
      {
        id: 'gemini-3.1-flash-image',
        label: 'Gemini',
        capabilities: ['generate', 'edit'],
      },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }
  const preparedGeminiProfile: BuiltinEdgeProfile = {
    id: preparedGemini.id,
    source: 'builtin-edge',
    channelId: preparedGemini.id,
    selectedModelId: preparedGemini.models[0].id,
  }

  function setupPreparedState() {
    setChannels([preparedOpenAI, preparedGemini])
    const profile: BuiltinEdgeProfile = {
      id: preparedOpenAI.id,
      source: 'builtin-edge',
      channelId: preparedOpenAI.id,
      selectedModelId: 'gpt-image-1',
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile, preparedGeminiProfile],
        activeProfileId: profile.id,
        clearInputAfterSubmit: false,
      }),
      prompt: '',
      slotValues: {},
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS, n: 1 },
      tasks: [],
      detailTaskId: null,
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  }

  beforeEach(async () => {
    await bootstrapClientCapabilities(false, '')
    setSignedIn(false)
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValue({
      images: ['data:image/png;base64,generated'],
      actualParamsList: [{ size: '1x1' }],
    })
    setChannels([])
    await clearImages()
    await putImage({ id: imageA.id, dataUrl: PREPARED_IMAGE, source: 'upload', createdAt: 0 })
    setupPreparedState()
  })

  it('转圈期间改了输入框，到点后不清空新输入', async () => {
    useStore.setState({
      settings: { ...useStore.getState().settings, clearInputAfterSubmit: true },
      prompt: '一只猫',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
    })
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = submitTask({ holdClear: hold })
    await vi.waitFor(() => expect(useStore.getState().tasks).toHaveLength(1))
    useStore.setState({ prompt: '一只狗' })
    release()
    await pending
    expect(useStore.getState().prompt).toBe('一只狗')
    expect(useStore.getState().inputImages).toHaveLength(1)

    useStore.setState({ tasks: [], prompt: '一只猫' })
    await submitTask({ holdClear: Promise.resolve() })
    expect(useStore.getState().prompt).toBe('')
    expect(useStore.getState().inputImages).toHaveLength(0)
  })

  it('只有用户主动发送才记下作品卡注意力', async () => {
    dismissSubmittedTasks([...submittedTaskSnapshot()])
    useStore.setState({ prompt: '  ' })
    await submitTask()
    expect(submittedTaskSnapshot()).toEqual([])

    useStore.setState({
      prompt: '一只猫',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
    })
    await submitTask()
    const sent = useStore.getState().tasks[0]
    expect(sent).toBeTruthy()
    expect(submittedTaskSnapshot()).toEqual([sent?.id])

    dismissSubmittedTasks([sent?.id ?? ''])
    useStore.setState({ tasks: [], prompt: '', inputImages: [] })
    const ids = await submitPrepared({
      prompt: '一只猫',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
      params: { ...DEFAULT_PARAMS, n: 1 },
    })
    expect(ids).toHaveLength(1)
    expect(submittedTaskSnapshot()).toEqual([])
  })

  it('返回创建的任务 id，产出与 composer 路径同形的任务', async () => {
    useStore.setState({
      prompt: '一只猫',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
    })
    await submitTask()
    const composerTask = useStore.getState().tasks[0]

    useStore.setState({ tasks: [], prompt: '', inputImages: [] })
    const ids = await submitPrepared({
      prompt: '一只猫',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
      params: { ...DEFAULT_PARAMS, n: 1 },
    })

    expect(ids).toHaveLength(1)
    const prepared = useStore.getState().tasks[0]
    expect(prepared.id).toBe(ids[0])
    expect(prepared).toMatchObject({
      prompt: composerTask.prompt,
      apiProvider: composerTask.apiProvider,
      apiProfileId: composerTask.apiProfileId,
      apiProfileName: composerTask.apiProfileName,
      apiModel: composerTask.apiModel,
      inputImageIds: composerTask.inputImageIds,
    })
    expect(prepared.params).toEqual(composerTask.params)
    expect(prepared.clientRequestId).toBeTruthy()
  })

  it('归属信息落进任务记录并持久化，不带时记录里没有该字段', async () => {
    const [withOrigin] = await submitPrepared({
      prompt: '主图',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 1 },
      origin: { setId: 'set-1', shotId: 'shot-3' },
    })

    expect(useStore.getState().tasks[0].origin).toEqual({ setId: 'set-1', shotId: 'shot-3' })
    const persisted = (await getAllTasks()).find((t) => t.id === withOrigin)
    expect(persisted?.origin).toEqual({ setId: 'set-1', shotId: 'shot-3' })

    useStore.setState({ tasks: [] })
    await submitPrepared({ prompt: '主图', inputImages: [], params: { ...DEFAULT_PARAMS, n: 1 } })
    expect(useStore.getState().tasks[0].origin).toBeUndefined()
  })

  it('显式提交同样拦截超过 16 张的槽位展开结果', async () => {
    const ids = await submitPrepared({
      prompt: '{场景}',
      slotValues: { 场景: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 2 },
    })

    expect(ids).toEqual([])
    expect(useStore.getState().tasks).toHaveLength(0)
    expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('只产出一条任务时复用传入的幂等键，分发成多条时各自唯一', async () => {
    await submitPrepared({
      prompt: 'p',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 1 },
      clientRequestId: 'req-1',
    })
    expect(useStore.getState().tasks[0].clientRequestId).toBe('req-1')

    useStore.setState({ tasks: [] })
    await submitPrepared({
      prompt: 'p',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 3 },
      clientRequestId: 'req-1',
    })
    const keys = useStore.getState().tasks.map((t) => t.clientRequestId)
    expect(new Set(keys).size).toBe(3)
    expect(keys).not.toContain('req-1')
  })

  it('按 profileId 提交时任务记录带该配置的快照，不受当前活动配置影响', async () => {
    await submitPrepared({
      prompt: 'p',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 1 },
      profileId: preparedGeminiProfile.id,
    })

    expect(useStore.getState().tasks[0]).toMatchObject({
      apiProfileId: preparedGeminiProfile.id,
      apiProvider: 'gemini',
    })
    expect(useStore.getState().settings.activeProfileId).toBe('default-openai')
  })

  it('explicit model is used by dispatch without changing the selected model', async () => {
    const profile: BuiltinEdgeProfile = {
      id: preparedOpenAI.id,
      source: 'builtin-edge',
      channelId: preparedOpenAI.id,
      selectedModelId: 'gpt-image-1',
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
    })
    await submitPrepared({
      prompt: '商品',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 1 },
      profileId: profile.id,
      modelId: 'gpt-image-2',
    })
    await waitUntil(() => vi.mocked(callImageApi).mock.calls.length > 0, 'model dispatch missing')
    expect(
      vi.mocked(callImageApi).mock.calls[0][0].settings.profiles.find((p) => p.id === profile.id)
        ?.selectedModelId,
    ).toBe('gpt-image-2')
    expect(useStore.getState().tasks[0].apiModel).toBe('gpt-image-2')
    expect(
      useStore.getState().settings.profiles.find((p) => p.id === profile.id)?.selectedModelId,
    ).toBe('gpt-image-1')
  })

  it('遮罩按显式参数写进任务记录', async () => {
    await putImage({
      id: 'mask-image',
      dataUrl: 'data:image/png;base64,mask',
      source: 'mask',
      createdAt: 0,
    })
    await submitPrepared({
      prompt: 'p',
      inputImages: [{ id: imageA.id, dataUrl: PREPARED_IMAGE }],
      params: { ...DEFAULT_PARAMS, n: 1 },
      mask: { imageId: 'mask-image', targetImageId: imageA.id },
    })

    expect(useStore.getState().tasks[0]).toMatchObject({
      maskImageId: 'mask-image',
      maskTargetImageId: imageA.id,
    })
  })
})

describe('展开平台记录的详情', () => {
  it('平台记录落成本机任务时用用户原文，不带防改写前缀（重试不会再钉一遍）', async () => {
    readRemoteGeneration.mockResolvedValue({
      id: 'gen-guard',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'completed',
      archiveStatus: 'none',
      errorType: null,
      cover: null,
      createdAt: 1_000,
      startedAt: 2_000,
      completedAt: 62_000,
      revision: '1',
      prompt: `${PROMPT_REWRITE_GUARD_PREFIX}\n一只猫`,
      parameters: {},
      actualParameters: {},
      inputs: [],
      mask: null,
      outputs: [],
    })
    useStore.setState({ tasks: [] })

    const local = await materializeRemoteTask(
      task({ id: 'gen-guard', remoteOnly: true, prompt: '一只猫', outputImages: [] }),
    )

    expect(local.prompt).toBe('一只猫')
    expect(useStore.getState().tasks[0]?.prompt).toBe('一只猫')
  })

  it('平台那条已经跑完时卡片跟着落终态，不再一直显示生成中', async () => {
    const image = (mediaId: string) => ({
      index: 0,
      mediaId,
      width: null,
      height: null,
      contentType: 'image/png',
    })
    readRemoteGeneration.mockResolvedValue({
      id: 'gen-1',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'completed',
      archiveStatus: 'none',
      errorType: null,
      cover: null,
      createdAt: 1_000,
      startedAt: 2_000,
      completedAt: 62_000,
      revision: '1',
      prompt: '一只猫',
      parameters: {},
      actualParameters: {},
      inputs: [image('in-1')],
      mask: null,
      outputs: [image('out-1')],
    })
    const running = {
      id: 'gen-1',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'in_progress',
      archiveStatus: 'none',
      errorType: null,
      cover: null,
      createdAt: 1_000,
      startedAt: 2_000,
      completedAt: null,
      revision: '1',
      prompt: '一只猫',
      parameters: {},
      actualParameters: {},
      inputs: [],
      mask: null,
    } as const
    useStore.setState({
      tasks: [],
      platformGenerations: [{ id: 'gen-1', record: running, fetchedAt: 0 }],
      detailTaskId: null,
    })

    useStore.getState().setDetailTaskId('gen-1')

    const card = () => mergeHistory([], useStore.getState().platformGenerations)[0]
    await waitUntil(() => card()?.status === 'done', '详情已经读到 completed，卡片仍停在 running')
    expect(card()).toMatchObject({
      finishedAt: 62_000,
      elapsed: 60_000,
      outputImages: ['aip-media:out-1'],
      inputImageIds: ['aip-media:in-1'],
    })
  })

  it('本机残留卡的详情用平台任务号补齐整组产出', async () => {
    const running = {
      id: 'gen-2',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'in_progress',
      archiveStatus: 'none',
      errorType: null,
      cover: null,
      createdAt: 1_000,
      startedAt: 2_000,
      completedAt: null,
      revision: '1',
      prompt: '两张图',
      parameters: {},
      actualParameters: {},
      inputs: [],
      mask: null,
    } as const
    const output = (index: number) => ({
      index,
      mediaId: `out-${index}`,
      width: null,
      height: null,
      contentType: 'image/png',
    })
    readRemoteGeneration.mockResolvedValue({
      ...running,
      status: 'completed',
      archiveStatus: 'ready',
      completedAt: 62_000,
      cover: output(0),
      outputs: [output(0), output(1)],
    })
    useStore.setState({
      tasks: [
        task({
          id: 'local-2',
          bffRequestId: 'gen-2',
          status: 'running',
          outputImages: [],
          finishedAt: null,
        }),
      ],
      // 首次拉取列表前也能按本机任务上的服务端请求号展开详情。
      platformGenerations: [],
      detailTaskId: null,
    })

    useStore.getState().setDetailTaskId('local-2')

    const card = () =>
      mergeHistory(useStore.getState().tasks, useStore.getState().platformGenerations)[0]
    await waitUntil(() => card()?.outputImages.length === 2, '详情没有补齐平台的两张产出')
    expect(readRemoteGeneration).toHaveBeenCalledWith('gen-2')
    expect(card()).toMatchObject({
      id: 'local-2',
      status: 'done',
      outputImages: ['aip-media:out-0', 'aip-media:out-1'],
    })
  })

  it('完成但归档未就绪时，重新展开还能补到稍后归档的图片', async () => {
    const base = {
      id: 'gen-late',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'completed',
      archiveStatus: 'pending',
      errorType: null,
      cover: null,
      createdAt: 1_000,
      startedAt: 2_000,
      completedAt: 62_000,
      revision: '1',
      prompt: '迟到的归档',
      parameters: {},
      actualParameters: {},
      inputs: [],
      mask: null,
      outputs: [],
    } as const
    const cover = {
      index: 0,
      mediaId: 'late-output',
      width: null,
      height: null,
      contentType: 'image/png',
    }
    readRemoteGeneration
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, archiveStatus: 'ready', cover, outputs: [cover] })
    useStore.setState({
      tasks: [task({ id: 'local-late', bffRequestId: base.id, status: 'running' })],
      platformGenerations: [],
      detailTaskId: null,
    })

    useStore.getState().setDetailTaskId('local-late')
    await waitUntil(
      () => useStore.getState().platformGenerations.some((row) => row.id === base.id),
      '首次详情未缓存',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const beforeReopen = readRemoteGeneration.mock.calls.filter(([id]) => id === base.id).length
    useStore.getState().setDetailTaskId(null)
    useStore.getState().setDetailTaskId('local-late')
    expect(readRemoteGeneration.mock.calls.filter(([id]) => id === base.id)).toHaveLength(
      beforeReopen + 1,
    )
    await waitUntil(
      () =>
        mergeHistory(useStore.getState().tasks, useStore.getState().platformGenerations)[0]
          ?.outputImages.length === 1,
      '二次展开未补到归档图片',
    )
  })
})

describe('confirmDialogAsync', () => {
  const dialog = { title: 'Confirm', message: 'Sure?' }
  beforeEach(() => {
    useStore.setState({
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => useStore.setState({ confirmDialog }),
    })
  })

  it('resolves with the user choice and clears its dialog', async () => {
    const confirming = confirmDialogAsync(dialog)
    useStore.getState().confirmDialog?.action()
    expect(await confirming).toBe(true)
    expect(useStore.getState().confirmDialog).toBeNull()
  })

  it('treats abort and a replacing dialog as cancel without clearing the replacement', async () => {
    const controller = new AbortController()
    const aborted = confirmDialogAsync(dialog, controller.signal)
    controller.abort()
    expect(await aborted).toBe(false)
    expect(useStore.getState().confirmDialog).toBeNull()

    const replaced = confirmDialogAsync(dialog)
    const other = { ...dialog, title: 'Other', action: () => {} }
    useStore.getState().setConfirmDialog(other)
    expect(await replaced).toBe(false)
    expect(useStore.getState().confirmDialog).toBe(other)
    useStore.getState().setConfirmDialog(null)
  })
})
