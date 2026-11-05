/**
 * CLI 接入页里每个 Agent 宿主的接入方式。命令与目录约定来自 `cli-go`（install.sh / install.ps1 与
 * `muvloom skill install`）；这里只放展示用的配置，不重复实现安装逻辑。
 * 给 Agent 的提示词正文放在 locale（`auth:cliConnect.prompt.*`），命令作为插值传入，保证跟界面语言走。
 */

export type ConnectAgentId = 'claude-code' | 'codex' | 'other'
export type ConnectPlatform = 'unix' | 'windows'

/** 官方安装脚本。走 GitHub release 并校验 SHA-256，见 cli-go/internal/skill/assets/references/install.md。 */
export const INSTALL_COMMAND: Record<ConnectPlatform, string> = {
  unix: 'curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.sh | sh',
  windows:
    'irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.ps1 | iex',
}

/** 宿主对应的 `muvloom skill install --host`；其它 Agent 没有 Skill 目录，不装 Skill。 */
export function skillInstallCommand(agent: ConnectAgentId): string | null {
  return agent === 'other' ? null : `muvloom skill install --host ${agent}`
}

/** 手动做同样的事，终端里逐行执行。 */
export function manualCommands(agent: ConnectAgentId, platform: ConnectPlatform): string[] {
  const skill = skillInstallCommand(agent)
  return [INSTALL_COMMAND[platform], ...(skill ? [skill] : []), 'muvloom auth login']
}

/** 运行时按系统猜一个默认平台；猜不出来按类 Unix 处理。 */
export function detectPlatform(userAgent: string): ConnectPlatform {
  return /windows/i.test(userAgent) ? 'windows' : 'unix'
}
