/** 能不能把当前项目开成节点画布。本机与云端均由同一个能力开关控制。 */
export function shouldUseNodeCanvas(
  project: { readonly cloud?: unknown } | undefined,
  enabled: { readonly capability: boolean; readonly cloudProjects: boolean },
): boolean {
  // 目录里还没有这条记录时不能开工。记录未到会被当成「没有 cloud」，
  // 空快照会把 legacyImported 永久置上，之后没有再迁移的出路。
  return enabled.capability && project !== undefined
}
