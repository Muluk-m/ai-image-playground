/**
 * 镜像构建时打进来的来源提交；直接构建、没传参数时是 unknown。
 * 单独成文件、不引任何模块：app.ts 要用它，而 heartbeat 会顺带把数据库客户端提前初始化。
 */
export function appVersion(): string {
  return process.env.APP_VERSION?.trim() || 'unknown'
}

/** Product release (MAJOR.MINOR.PATCH). The commit identity stays in APP_VERSION. */
export function appRelease(): string {
  return process.env.APP_RELEASE?.trim() || 'unknown'
}

/**
 * 发布时的配置来源（ADR 0035）：rollout-runtime.sh 注入。`rendered` 带生成配置的摘要，
 * 发布后据此确认执行器确实跑在部署描述要求的配置上。
 */
export function appConfig(): { source: string; digest: string | null } {
  return {
    source: process.env.DEPLOY_CONFIG_SOURCE?.trim() || 'unknown',
    digest: process.env.DEPLOY_CONFIG_DIGEST?.trim() || null,
  }
}
