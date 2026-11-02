/** 目录里有这条项目就用节点画布。记录未到时不能开工，否则空快照会把旧档标成已迁移。 */
export function shouldUseNodeCanvas(project: object | undefined): boolean {
  return project !== undefined
}
