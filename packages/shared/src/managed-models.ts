/** 后台「模型」页的一行。上下架归公开库；单价归收费模块，由它自己往这一行上补。 */
export type ManagedModelKind = 'image' | 'video' | 'chat'

export interface ManagedModel {
  id: string
  label: string
  kind: ManagedModelKind
  active: boolean
  /** 有值即系统自动暂停：上游没有可用账号，补上容量后由运营恢复。 */
  pause_reason: 'upstream_unavailable' | null
  paused_at: number | null
}

export interface ManagedModelsView {
  models: ManagedModel[]
}
