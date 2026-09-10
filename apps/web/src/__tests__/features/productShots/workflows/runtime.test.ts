import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { productShotJobStore } from '../../../../features/productShots/lib/jobStore'
import { useProductShotsStore } from '../../../../features/productShots/store'
import { kitSpecs } from '../../../../features/productShots/workflows/plan'
import {
  retryProductWorkflow,
  submitProductWorkflow,
  updateWorkflowTitle,
  useWorkflowEditor,
  workflowModels,
} from '../../../../features/productShots/workflows/runtime'
import {
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../../../../lib/apiProfiles'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../../../types'

const submitPrepared = vi.hoisted(() => vi.fn())
const ensureImageCached = vi.hoisted(() =>
  vi.fn(async (id: string) => `data:image/png;base64,${id}`),
)
vi.mock('../../../../store', async (original) => ({
  ...(await original<typeof import('../../../../store')>()),
  submitPrepared,
  ensureImageCached,
}))
vi.mock('../../../../lib/canvasImage', async (original) => ({
  ...(await original<typeof import('../../../../lib/canvasImage')>()),
  getImageDimensions: async () => ({ width: 100, height: 80 }),
}))

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const profile = createDefaultOpenAIByokProfile({ apiKey: 'test-key' })
  useStore.setState({
    tasks: [],
    params: { ...DEFAULT_PARAMS, n: 4 },
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    }),
    showToast: vi.fn(),
  })
  useProductShotsStore.setState({ jobs: [] })
  useProductShotsStore.getState().startNewJob()
  const draft = useProductShotsStore.getState().draft
  useProductShotsStore.setState({
    draft: {
      ...draft,
      id: 'job-1',
      createdAt: 1,
      images: [
        {
          imageId: 'original',
          versions: [
            {
              id: 'parent',
              taskId: 'parent-task',
              plan: '原版',
              prompt: '原版',
              masked: false,
              createdAt: 1,
            },
          ],
          chosenVersionId: 'parent',
        },
      ],
    },
    selectedImageId: 'original',
  })
  const savedDraft = useProductShotsStore.getState().draft
  useProductShotsStore.setState({
    jobs: [{ ...savedDraft, id: 'job-1', createdAt: 1, updatedAt: 1 }],
  })
  useStore.setState({
    tasks: [
      {
        id: 'parent-task',
        status: 'done',
        outputImages: ['chosen-output'],
        params: DEFAULT_PARAMS,
      } as TaskRecord,
    ],
  })
  useWorkflowEditor.setState({ session: null, submitting: false })
  ensureImageCached.mockClear()
  submitPrepared
    .mockReset()
    .mockImplementation(async () => [`task-${submitPrepared.mock.calls.length}`])
})
afterEach(() => vi.unstubAllGlobals())
const target = () => ({
  jobId: useProductShotsStore.getState().draft.id!,
  imageId: 'original',
  versionId: 'parent',
})
const versions = () => useProductShotsStore.getState().draft.images[0].versions
const model = () => workflowModels()[0].key

it('creates six independent outputs from the chosen version, retaining the original and settings', async () => {
  const settings = useStore.getState().settings
  const specs = kitSpecs(['square', 'portrait', 'wide'], ['zh', 'en'], { zh: '新品', en: 'New' })
  await submitProductWorkflow(target(), specs, model())
  expect(submitPrepared).toHaveBeenCalledTimes(6)
  expect(submitPrepared.mock.calls.map(([arg]) => arg.params.size)).toEqual([
    '1024x1024',
    '1024x1024',
    '1024x1536',
    '1024x1536',
    '1536x1024',
    '1536x1024',
  ])
  for (const [arg] of submitPrepared.mock.calls) {
    expect(arg.inputImages[0].id).toBe('chosen-output')
    expect(arg.params.n).toBe(1)
  }
  expect(versions()).toHaveLength(7)
  expect(versions()[0].id).toBe('parent')
  expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe('parent')
  expect(useStore.getState().settings).toBe(settings)
  const saved = (await productShotJobStore.list()).find((j) => j.id === target().jobId)
  expect(saved?.images[0].versions).toEqual(versions())
})

it('refines only the explicitly selected draft, ignoring another preview', async () => {
  useProductShotsStore.setState({ previewVersionId: 'some-other-version' })
  await submitProductWorkflow(
    target(),
    [{ kind: 'refine', size: '1536x1024', instruction: '' }],
    model(),
  )
  expect(submitPrepared).toHaveBeenCalledTimes(1)
  expect(submitPrepared.mock.calls[0][0].inputImages.map((i: { id: string }) => i.id)).toEqual([
    'chosen-output',
  ])
  expect(versions()[1].workflow?.sourceVersionId).toBe('parent')
})

it('retries one failed item without replacing its siblings and edits title without generation', async () => {
  await submitProductWorkflow(
    target(),
    kitSpecs(['square', 'wide'], ['zh'], { zh: '旧标题', en: '' }),
    model(),
  )
  const before = versions(),
    retry = before[1]
  await retryProductWorkflow(target(), retry)
  expect(submitPrepared).toHaveBeenCalledTimes(3)
  expect(versions()).toHaveLength(3)
  expect(versions()[2]).toEqual(before[2])
  expect(versions()[1].taskId).not.toBe(retry.taskId)
  await updateWorkflowTitle(target(), retry, '新标题')
  expect(submitPrepared).toHaveBeenCalledTimes(3)
  expect(versions()[1].taskId).toBe('task-3')
  expect(versions()[1].workflow?.spec).toMatchObject({ title: '新标题' })
})

it('keeps submitted results with the originating job when selection changes', async () => {
  const original = target()
  submitPrepared.mockImplementationOnce(async () => {
    useProductShotsStore.getState().startNewJob()
    return ['task-away']
  })
  await submitProductWorkflow(
    original,
    [{ kind: 'refine', size: '1024x1024', instruction: '' }],
    model(),
  )
  expect(useProductShotsStore.getState().draft.images).toEqual([])
  expect(
    useProductShotsStore.getState().jobs.find((j) => j.id === original.jobId)?.images[0].versions,
  ).toHaveLength(2)
})

it('does not recreate a deleted source after submission completes', async () => {
  submitPrepared.mockImplementationOnce(async () => {
    useProductShotsStore.setState((s) => ({ draft: { ...s.draft, images: [] }, jobs: [] }))
    return ['orphan']
  })
  await submitProductWorkflow(
    target(),
    [{ kind: 'refine', size: '1024x1024', instruction: '' }],
    model(),
  )
  expect(useProductShotsStore.getState().draft.images).toEqual([])
})

it('rejects a running source before creating a task', async () => {
  useStore.setState((s) => ({ tasks: s.tasks.map((t) => ({ ...t, status: 'running' })) }))
  await expect(
    submitProductWorkflow(
      target(),
      [{ kind: 'refine', size: '1024x1024', instruction: '' }],
      model(),
    ),
  ).rejects.toThrow('已完成')
  expect(submitPrepared).not.toHaveBeenCalled()
  expect(useWorkflowEditor.getState().submitting).toBe(false)
})
