// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PreviewPanel from '../../../../features/productShots/components/PreviewPanel'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotVersion } from '../../../../features/productShots/types'
import { useWorkflowEditor } from '../../../../features/productShots/workflows/runtime'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../../../types'

const downloadImagesByIds = vi.hoisted(() => vi.fn())
const downloadBlob = vi.hoisted(() => vi.fn())
const renderKitImage = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/downloadImages', () => ({ downloadImagesByIds, downloadBlob }))
vi.mock('../../../../features/productShots/workflows/render', () => ({ renderKitImage }))
vi.mock('../../../../hooks/useImageThumbnail', () => ({
  useImageThumbnail: (id?: string) => (id ? { dataUrl: `data:,${id}` } : null),
}))
vi.mock('../../../../features/productShots/workflows/WorkflowImage', () => ({
  default: ({ imageId, alt }: { imageId?: string; alt: string }) => (
    <span data-image-id={imageId}>{alt}</span>
  ),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const version: ProductShotVersion = {
  id: 'edited',
  taskId: 'task',
  plan: '',
  prompt: '',
  masked: true,
  createdAt: 1,
  workflow: {
    spec: { kind: 'edit', instruction: '移除绿植', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    sourceImageId: 'immutable-source',
    sourceVersionId: 'parent',
    inputImageIds: ['immutable-source'],
    params: DEFAULT_PARAMS,
    profileId: 'default-openai',
    modelId: 'gpt-image-2',
    groupId: 'group',
  },
}
const button = (label: string) => {
  const result = [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.clearAllMocks()
  downloadImagesByIds.mockResolvedValue({ success: 1, failed: 0 })
  useWorkflowEditor.setState({ session: null })
  useProductShotsStore.getState().startNewJob()
  useProductShotsStore.setState((s) => ({
    draft: { ...s.draft, id: 'job', images: [{ imageId: 'original', versions: [version] }] },
    selectedImageId: 'original',
    previewVersionId: version.id,
    matteOverlayVersionId: null,
  }))
  useStore.setState({
    tasks: [{ id: 'task', status: 'done', outputImages: ['result'] }] as TaskRecord[],
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
it('opens editing and kit workflows for the visible version and hides actions without a completed output', async () => {
  await act(async () => root.render(<PreviewPanel />))
  await act(async () => button('局部编辑').click())
  expect(useWorkflowEditor.getState().session).toMatchObject({ kind: 'edit', versionId: 'edited' })
  await act(async () => button('批量衍生').click())
  expect(useWorkflowEditor.getState().session).toMatchObject({ kind: 'kit', versionId: 'edited' })
  await act(async () =>
    useStore.setState({
      tasks: [{ id: 'task', status: 'running', outputImages: [] }] as TaskRecord[],
    }),
  )
  expect(host.querySelector('[aria-label="图像操作"]')).toBeNull()
})
it('compares the immutable source with the visible result and clears comparison when returning to the original', async () => {
  await act(async () => root.render(<PreviewPanel />))
  await act(async () => button('对比').click())
  const comparison = host.querySelector('[aria-label="版本对比"]')
  expect(
    [...comparison!.querySelectorAll('[data-image-id]')].map((el) =>
      el.getAttribute('data-image-id'),
    ),
  ).toEqual(['immutable-source', 'result'])
  await act(async () => button('原图').click())
  await act(async () => button('当前版').click())
  expect(host.querySelector('[aria-label="版本对比"]')).toBeNull()
  expect(button('对比').getAttribute('aria-pressed')).toBe('false')
})
it('exports the visible image once while the download is pending', async () => {
  let finish!: (value: { success: number; failed: number }) => void
  downloadImagesByIds.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  await act(async () => root.render(<PreviewPanel />))
  await act(async () => {
    button('导出').click()
    button('导出').click()
  })
  expect(downloadImagesByIds).toHaveBeenCalledExactlyOnceWith(['result'], 'product-1-v1')
  expect(button('导出中…').disabled).toBe(true)
  await act(async () => finish({ success: 1, failed: 0 }))
  expect(button('导出').disabled).toBe(false)
})
it('exports kit output with its saved title and composition', async () => {
  const kit = {
    ...version,
    workflow: {
      ...version.workflow!,
      spec: {
        kind: 'kit' as const,
        format: 'square' as const,
        language: 'zh' as const,
        title: '新品上市',
      },
    },
  }
  useProductShotsStore.setState((s) => ({
    draft: { ...s.draft, images: [{ imageId: 'original', versions: [kit] }] },
  }))
  const blob = new Blob(['composited'], { type: 'image/png' })
  renderKitImage.mockResolvedValue(blob)
  await act(async () => root.render(<PreviewPanel />))
  await act(async () => button('导出').click())
  expect(renderKitImage).toHaveBeenCalledExactlyOnceWith('result', kit)
  expect(downloadBlob).toHaveBeenCalledWith(blob, expect.stringMatching(/\.png$/))
  expect(downloadImagesByIds).not.toHaveBeenCalled()
})
