import { create } from 'zustand'
import { getActiveApiProfile, normalizeSettings } from '../../../lib/apiProfiles'
import { scopedStorageName } from '../../../lib/authScope'
import { getImageDimensions } from '../../../lib/canvasImage'
import { getProfileModels, modelSupportsEdit } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { ensureImageCached, storeImageFromUrl, submitPrepared, useStore } from '../../../store'
import type { InputImage } from '../../../types'
import { useLibraryStore } from '../../library/store'
import { recordWorkflowVersions, useProductShotsStore } from '../store'
import type { ProductShotVersion } from '../types'
import {
  buildWorkflowPrompt,
  type WorkflowRecipe,
  type WorkflowSpec,
  workflowLabel,
  workflowParams,
} from './plan'
import { renderKitImage } from './render'

export interface WorkflowTarget {
  jobId: string
  imageId: string
  versionId?: string
}
export interface WorkflowSession extends WorkflowTarget {
  kind: WorkflowSpec['kind']
  resultVersionId?: string
}
export const useWorkflowEditor = create<{ session: WorkflowSession | null; submitting: boolean }>(
  () => ({ session: null, submitting: false }),
)
export function openWorkflow(kind: WorkflowSpec['kind'], versionId?: string): void {
  const { draft, selectedImageId } = useProductShotsStore.getState()
  if (draft.id && selectedImageId)
    useWorkflowEditor.setState({
      session: { kind, jobId: draft.id, imageId: selectedImageId, versionId },
    })
}
export function reviewWorkflow(version: ProductShotVersion): void {
  if (!version.workflow) return
  openWorkflow(version.workflow.spec.kind, version.workflow.sourceVersionId)
  const session = useWorkflowEditor.getState().session
  if (session) useWorkflowEditor.setState({ session: { ...session, resultVersionId: version.id } })
}
export function closeWorkflow(): void {
  useWorkflowEditor.setState({ session: null })
}

export function workflowModels() {
  const settings = normalizeSettings(useStore.getState().settings)
  const channels = getPublicChannels()
  return settings.profiles.flatMap((profile) =>
    getProfileModels(profile, channels)
      .filter((modelId) => modelSupportsEdit({ ...profile, selectedModelId: modelId }, channels))
      .map((modelId) => ({
        profileId: profile.id,
        modelId,
        key: JSON.stringify([profile.id, modelId]),
        label: `${modelId} · ${profile.source === 'user-byok' ? profile.name : (channels.find((c) => c.id === profile.channelId)?.label ?? profile.channelId)}`,
      })),
  )
}
export function defaultWorkflowModel(kind: WorkflowSpec['kind']): string {
  const choices = workflowModels(),
    active = getActiveApiProfile(useStore.getState().settings)
  const desired = kind === 'draft' ? 'gpt-image-2.5-flare' : 'gpt-image-2.5-sunburst'
  return (
    (
      choices.find((c) => c.profileId === active.id && c.modelId === desired) ??
      choices.find((c) => c.profileId === active.id && c.modelId === active.selectedModelId) ??
      choices[0]
    )?.key ?? ''
  )
}
export function workflowSource(target: WorkflowTarget) {
  const state = useProductShotsStore.getState()
  const images =
    state.draft.id === target.jobId
      ? state.draft.images
      : state.jobs.find((j) => j.id === target.jobId)?.images
  const image = images?.find((i) => i.imageId === target.imageId)
  if (!image) throw new Error('原图或商品图任务已删除')
  const version = target.versionId
    ? image.versions.find((v) => v.id === target.versionId)
    : undefined
  const task = version ? useStore.getState().tasks.find((t) => t.id === version.taskId) : undefined
  if (target.versionId && (!version || task?.status !== 'done' || !task.outputImages[0]))
    throw new Error('请先选一张已完成的版本')
  return { image, version, task, sourceImageId: task?.outputImages[0] ?? target.imageId }
}

async function inputImage(id: string): Promise<InputImage> {
  const dataUrl = await ensureImageCached(id)
  if (!dataUrl) throw new Error('来源图片已丢失，请重新导入')
  return { id, dataUrl }
}
async function editMask(image: InputImage, spec: WorkflowSpec) {
  if (spec.kind !== 'edit') return null
  const { width, height } = await getImageDimensions(image.dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建修改区域')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  const { x, y, w, h } = spec.box
  context.clearRect(x * width, y * height, w * width, h * height)
  const mask = await storeImageFromUrl(canvas.toDataURL('image/png'))
  return { imageId: mask.id, targetImageId: image.id }
}

export async function submitProductWorkflow(
  target: WorkflowTarget,
  specs: WorkflowSpec[],
  modelKey: string,
): Promise<void> {
  await withSubmission(async (scope) => {
    const model = workflowModels().find((m) => m.key === modelKey)
    if (!model) throw new Error('请先选择可用的图片模型')
    if (specs.length === 0 || specs.length > 6) throw new Error('请选择 1 到 6 张图片')
    specs.forEach(buildWorkflowPrompt)
    const source = workflowSource(target)
    const { version, task } = source
    let sourceImageId = source.sourceImageId
    if (version?.workflow?.spec.kind === 'kit') {
      const blob = await renderKitImage(sourceImageId, version)
      if (scopedStorageName('workflow') !== scope) return
      const url = URL.createObjectURL(blob)
      try {
        sourceImageId = (await storeImageFromUrl(url)).id
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    const productId =
      useLibraryStore.getState().assets.find((a) => a.id === version?.productAssetId)?.imageId ??
      version?.workflow?.inputImageIds[1]
    const ids = [...new Set([sourceImageId, ...(productId ? [productId] : [])])]
    const groupId = crypto.randomUUID()
    const params = task?.params ?? useStore.getState().params
    const recipes = specs.map((spec) => ({
      spec,
      sourceImageId,
      sourceVersionId: target.versionId,
      inputImageIds: ids,
      params: workflowParams(params, spec),
      profileId: model.profileId,
      modelId: model.modelId,
      groupId,
    }))
    await submitRecipes(target, recipes, scope)
  })
}

async function submitRecipes(
  target: WorkflowTarget,
  recipes: WorkflowRecipe[],
  scope: string,
  retryId?: string,
): Promise<void> {
  for (const recipe of recipes) {
    if (scopedStorageName('workflow') !== scope) break
    workflowSource(target)
    const inputs = await Promise.all(recipe.inputImageIds.map(inputImage))
    const mask = await editMask(inputs[0], recipe.spec)
    if (scopedStorageName('workflow') !== scope) break
    workflowSource(target)
    const id = retryId ?? crypto.randomUUID(),
      prompt = buildWorkflowPrompt(recipe.spec)
    const [taskId] = await submitPrepared({
      prompt,
      inputImages: inputs,
      params: recipe.params,
      profileId: recipe.profileId,
      modelId: recipe.modelId,
      mask,
      origin: { setId: target.jobId, shotId: `${target.imageId}:${id}` },
    })
    if (!taskId) throw new Error('生成未提交，请检查模型配置或积分')
    if (scopedStorageName('workflow') !== scope) break
    const version: ProductShotVersion = {
      id,
      taskId,
      prompt,
      plan: workflowLabel(recipe),
      masked: mask !== null,
      workflow: recipe,
      createdAt: Date.now(),
      ...(mask ? { maskImageId: mask.imageId, maskTargetImageId: mask.targetImageId } : {}),
    }
    await recordWorkflowVersions(target.jobId, target.imageId, [version])
    const current = useProductShotsStore.getState()
    if (current.draft.id === target.jobId && current.selectedImageId === target.imageId)
      current.previewVersion(id)
  }
}

async function withSubmission(action: (scope: string) => Promise<void>): Promise<void> {
  if (useWorkflowEditor.getState().submitting) return
  useWorkflowEditor.setState({ submitting: true })
  try {
    await action(scopedStorageName('workflow'))
  } finally {
    useWorkflowEditor.setState({ submitting: false })
  }
}

export async function retryProductWorkflow(
  target: WorkflowTarget,
  version: ProductShotVersion,
): Promise<void> {
  if (!version.workflow || useWorkflowEditor.getState().submitting) return
  const task = useStore.getState().tasks.find((t) => t.id === version.taskId)
  if (task?.status === 'running') return
  const recipe = version.workflow
  await withSubmission((scope) =>
    submitRecipes({ ...target, versionId: undefined }, [recipe], scope, version.id),
  )
}
export async function updateWorkflowTitle(
  target: WorkflowTarget,
  version: ProductShotVersion,
  title: string,
): Promise<void> {
  const current = workflowSource({ ...target, versionId: undefined }).image.versions.find(
    (v) => v.id === version.id,
  )
  if (current?.workflow?.spec.kind !== 'kit') return
  const workflow = {
    ...current.workflow,
    spec: { ...current.workflow.spec, title: title.slice(0, 120) },
  }
  await recordWorkflowVersions(target.jobId, target.imageId, [{ ...current, workflow }])
}
