/**
 * 镜像构建时打进来的来源提交；直接构建、没传参数时是 unknown。
 * 单独成文件、不引任何模块：app.ts 要用它，而 heartbeat 会顺带把数据库客户端提前初始化。
 */
export function appVersion(): string {
  return process.env.APP_VERSION?.trim() || 'unknown'
}
