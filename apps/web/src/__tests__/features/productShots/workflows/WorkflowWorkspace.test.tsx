// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotVersion } from '../../../../features/productShots/types'
import WorkflowWorkspace, {
  KitResult,
} from '../../../../features/productShots/workflows/WorkflowWorkspace'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../../../types'

const submitProductWorkflow = vi.hoisted(() => vi.fn())
vi.mock('../../../../features/productShots/workflows/runtime', async (original) => ({
  ...(await original<typeof import('../../../../features/productShots/workflows/runtime')>()),
  submitProductWorkflow,
}))

vi.mock('../../../../features/productShots/workflows/WorkflowImage', () => ({
  default: ({ imageId, alt }: { imageId?: string; alt: string }) => (
    <span data-image-id={imageId}>{alt}</span>
  ),
}))
vi.mock('../../../../features/productShots/components/VersionBar', () => ({ default: () => null }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const parent: ProductShotVersion = {
  id: 'parent',
  taskId: 'parent-task',
  plan: '',
  prompt: '',
  masked: false,
  createdAt: 1,
}
const edited: ProductShotVersion = {
  id: 'edit',
  taskId: 'edit-task',
  plan: '',
  prompt: '',
  masked: true,
  createdAt: 2,
  workflow: {
    spec: { kind: 'edit', instruction: '去掉绿植', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    sourceImageId: 'actual-snapshot',
    sourceVersionId: 'parent',
    inputImageIds: ['actual-snapshot'],
    params: DEFAULT_PARAMS,
    profileId: 'default-openai',
    modelId: 'gpt-image-2',
    groupId: 'group',
  },
}
const session = { jobId: 'job', imageId: 'original', versionId: 'parent', kind: 'edit' as const }
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useProductShotsStore.getState().startNewJob()
  useProductShotsStore.setState((s) => ({
    draft: { ...s.draft, id: 'job', images: [{ imageId: 'original', versions: [parent, edited] }] },
    selectedImageId: 'original',
    previewVersionId: 'edit',
  }))
  useStore.setState({
    tasks: [
      { id: 'parent-task', status: 'done', outputImages: ['changed-parent'] },
      { id: 'edit-task', status: 'done', outputImages: ['edited-output'] },
    ] as TaskRecord[],
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
it('opens fresh controls even when this source already has an edited result', async () => {
  await act(async () => root.render(<WorkflowWorkspace session={session} />))
  expect(host.querySelector('textarea')).not.toBeNull()
  expect(host.querySelector('.cursor-crosshair')).not.toBeNull()
  expect(host.querySelector('[aria-label="前后对比位置"]')).toBeNull()
})
it('compares against the immutable input used by this result', async () => {
  await act(async () =>
    root.render(<WorkflowWorkspace session={{ ...session, resultVersionId: 'edit' }} />),
  )
  expect(
    [...host.querySelectorAll('[data-image-id]')]
      .find((e) => e.textContent === '修改前')
      ?.getAttribute('data-image-id'),
  ).toBe('actual-snapshot')
})
it('refreshes both title editors when either instance saves newer text', async () => {
  const kit: ProductShotVersion = {
    ...edited,
    workflow: {
      ...edited.workflow!,
      spec: { kind: 'kit', format: 'square', language: 'zh', title: '旧标题' },
    },
  }
  const render = (version: ProductShotVersion) => (
    <>
      <KitResult session={{ ...session, kind: 'kit' }} version={version} />
      <KitResult session={{ ...session, kind: 'kit' }} version={version} />
    </>
  )
  await act(async () => root.render(render(kit)))
  await act(async () => {
    for (const b of host.querySelectorAll('button')) if (b.textContent === '改文字') b.click()
  })
  const updated = {
    ...kit,
    workflow: {
      ...kit.workflow!,
      spec: {
        kind: 'kit' as const,
        format: 'square' as const,
        language: 'zh' as const,
        title: '新标题',
      },
    },
  }
  await act(async () => root.render(render(updated)))
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input[aria-label="标题"]')].map((i) => i.value),
  ).toEqual(['新标题', '新标题'])
})

it('keeps new settings visible when submission fails and older results exist', async () => {
  const refined = {
    ...edited,
    workflow: {
      ...edited.workflow!,
      spec: { kind: 'refine' as const, size: '1024x1024', instruction: '' },
    },
  }
  useProductShotsStore.setState((s) => ({
    draft: { ...s.draft, images: [{ imageId: 'original', versions: [parent, refined] }] },
  }))
  submitProductWorkflow.mockRejectedValueOnce(new Error('积分不足'))
  await act(async () => root.render(<WorkflowWorkspace session={{ ...session, kind: 'refine' }} />))
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '精修选中方案')!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(submitProductWorkflow).toHaveBeenCalledOnce()
  expect(host.querySelector('textarea')).not.toBeNull()
})
