import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dbTransaction,
  getImage,
  putImage,
  putTask,
  STORE_ASSETS,
  STORE_BGSWAP_JOBS,
  STORE_STORYBOARDS,
  STORE_VIDEO_TASKS,
} from '../../lib/db'
import { initStore, removeMultipleTasks, removeTask, useStore } from '../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('window', { requestIdleCallback: vi.fn() })
  useStore.setState({ tasks: [], inputImages: [], maskDraft: null, showToast: vi.fn() })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function images(ids: string[]) {
  for (const id of ids) {
    await putImage({ id, dataUrl: `data:image/png;base64,${btoa(id)}`, createdAt: 1 })
  }
}

async function productJob() {
  await dbTransaction(STORE_BGSWAP_JOBS, 'readwrite', (store) =>
    store.put({
      id: 'product-job',
      name: '商品图',
      preference: '',
      versionsPerImage: 1,
      createdAt: 1,
      updatedAt: 1,
      images: [
        {
          imageId: 'original',
          sourceMatte: {
            status: 'ready',
            backend: 'cloudflare-birefnet',
            edited: true,
            alphaImageId: 'alpha',
            targetImageId: 'target',
            previewImageId: 'preview',
          },
          versions: [
            {
              id: 'version',
              taskId: 'task',
              plan: '',
              prompt: '',
              masked: true,
              createdAt: 1,
              maskImageId: 'version-mask',
              maskTargetImageId: 'version-target',
              mattePreviewImageId: 'version-preview',
              workflow: { sourceImageId: 'workflow-source', inputImageIds: ['workflow-reference'] },
            },
          ],
        },
      ],
    }),
  )
}

describe('shared image ownership', () => {
  it('startup retains product masks, library assets, video frames and storyboard images while deleting true orphans', async () => {
    const retained = [
      'original',
      'alpha',
      'target',
      'preview',
      'version-mask',
      'version-target',
      'version-preview',
      'workflow-source',
      'workflow-reference',
      'asset',
      'first-frame',
      'last-frame',
      'story-reference',
      'story-reference-secondary',
      'story-image',
    ]
    await images([...retained, 'orphan', 'deleted-asset'])
    await productJob()
    await dbTransaction(STORE_ASSETS, 'readwrite', (store) =>
      store.put({ id: 'asset-record', imageId: 'asset' }),
    )
    await dbTransaction(STORE_ASSETS, 'readwrite', (store) =>
      store.put({ id: 'deleted', imageId: 'deleted-asset', deletedAt: 2 }),
    )
    await dbTransaction(STORE_VIDEO_TASKS, 'readwrite', (store) =>
      store.put({ id: 'video', firstFrameImageId: 'first-frame', lastFrameImageId: 'last-frame' }),
    )
    await dbTransaction(STORE_STORYBOARDS, 'readwrite', (store) =>
      store.put({
        id: 'story',
        referenceImageIds: ['story-reference', 'story-reference-secondary'],
        shots: [{ imageId: 'story-image' }],
      }),
    )

    await initStore()

    for (const id of retained) expect(await getImage(id), id).toBeDefined()
    expect(await getImage('orphan')).toBeUndefined()
    expect(await getImage('deleted-asset')).toBeUndefined()
  })

  it.each([
    'single',
    'multiple',
  ] as const)('%s history deletion does not destroy a product job that shares its input and mask', async (kind) => {
    await images(['original', 'alpha', 'generated'])
    await productJob()
    const task: TaskRecord = {
      id: 'task',
      prompt: '',
      params: { ...DEFAULT_PARAMS },
      inputImageIds: ['original'],
      maskImageId: 'alpha',
      maskTargetImageId: 'original',
      outputImages: ['generated'],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
    }
    await putTask(task)
    useStore.setState({ tasks: [task] })

    if (kind === 'single') await removeTask(task)
    else await removeMultipleTasks([task.id])

    expect(await getImage('original')).toBeDefined()
    expect(await getImage('alpha')).toBeDefined()
    expect(await getImage('generated')).toBeUndefined()
  })
})
