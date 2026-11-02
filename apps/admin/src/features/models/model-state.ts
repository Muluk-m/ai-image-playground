import type { ManagedModel } from '@image-playground/shared'

export type ModelState = 'active' | 'paused' | 'inactive'

/** 自动暂停是系统替运营下的架，和运营手动下架分开显示：前者等补上容量后要人来恢复。 */
export function modelState(model: ManagedModel): ModelState {
  if (model.active) return 'active'
  return model.pause_reason ? 'paused' : 'inactive'
}

/** 自动暂停的排最前，其余按 id。 */
export function sortModels(models: readonly ManagedModel[]): ManagedModel[] {
  return [...models].sort(
    (a, b) =>
      Number(modelState(b) === 'paused') - Number(modelState(a) === 'paused') ||
      a.id.localeCompare(b.id),
  )
}

export function modelSummary(models: readonly ManagedModel[]): string {
  const counts = { active: 0, paused: 0, inactive: 0 }
  for (const model of models) counts[modelState(model)] += 1
  return [
    counts.active ? `上架 ${counts.active}` : '',
    counts.paused ? `自动暂停 ${counts.paused}` : '',
    counts.inactive ? `下架 ${counts.inactive}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
