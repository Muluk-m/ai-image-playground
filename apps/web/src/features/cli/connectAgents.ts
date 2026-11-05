/**
 * `/connect` 上每个插件宿主的接入方式。命令来自已发布的 `cli-go`（install.sh / install.ps1 与
 * `muvloom skill install`）；这里只放展示用的配置，不重复实现安装逻辑。
 * 给宿主的提示词正文放在 locale（`auth:cliConnect.prompt.*`），命令作为插值传入，保证跟界面语言走。
 *
 * `muvloom skill install --host` 在当前发布里只接受 `claude-code` 与 `codex`
 * （`cli-go/internal/cli/skill.go`）。WorkBuddy 的技能目录是 `~/.workbuddy/skills/`，
 * 豆包工作在客户端「插件·技能·伙伴」里上传技能，都没有对应的 `--host`。
 * 这两个宿主因此只引导安装与授权，不生成 `skill install` 命令。
 */

export const CONNECT_AGENTS = ['workbuddy', 'doubao', 'claude-code', 'codex', 'other'] as const
export type ConnectAgentId = (typeof CONNECT_AGENTS)[number]
export type ConnectPlatform = 'unix' | 'windows'

const SKILL_HOSTS = new Set<ConnectAgentId>(['claude-code', 'codex'])

/**
 * 官方安装脚本固定到 CLI 发布对应的公开提交，而不是可移动的 `main` 或可重指向的 tag：用户复制的
 * 是已发布版本的脚本，之后分支上的改动不会悄悄变成别人电脑上的命令。脚本再校验下载的 CLI
 * SHA-256；发新版 CLI 时同时更新这两个常量。
 */
export const CLI_VERSION = '0.1.0'
export const CLI_RELEASE_REF = '0ac3c6410211e2a8532022b42a3c45cc10c1f5cc'
const INSTALL_BASE = `https://raw.githubusercontent.com/Muluk-m/ai-image-playground/${CLI_RELEASE_REF}/cli-go/install`
export const INSTALL_COMMAND: Record<ConnectPlatform, string> = {
  unix: `curl -fsSL ${INSTALL_BASE}/install.sh | MUVLOOM_VERSION=${CLI_VERSION} sh`,
  windows: `\$env:MUVLOOM_VERSION = "${CLI_VERSION}"; irm ${INSTALL_BASE}/install.ps1 | iex`,
}

/**
 * 安装脚本跑在子进程里，改不了当前终端的 PATH：安装目录不在 PATH 时，紧接着的 `muvloom`
 * 会找不到命令。Unix 尊重安装脚本的 `MUVLOOM_INSTALL_DIR`；Windows 刷新安装器写入的用户 PATH。
 */
export const SESSION_PATH: Record<ConnectPlatform, string> = {
  unix: 'export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"',
  windows:
    '$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")',
}

/** 当前 CLI 接受的 `muvloom skill install --host`。没有对应 host 的宿主返回 null。 */
export function skillInstallCommand(agent: ConnectAgentId): string | null {
  return SKILL_HOSTS.has(agent) ? `muvloom skill install --host ${agent}` : null
}

/** 复制给宿主的提示词。有技能安装命令的走 withSkill，WorkBuddy / 豆包各有一段不带 `--host` 的说明。 */
export function connectPromptKey(
  agent: ConnectAgentId,
):
  | 'cliConnect.prompt.withSkill'
  | 'cliConnect.prompt.workbuddy'
  | 'cliConnect.prompt.doubao'
  | 'cliConnect.prompt.noSkill' {
  if (skillInstallCommand(agent)) return 'cliConnect.prompt.withSkill'
  if (agent === 'workbuddy') return 'cliConnect.prompt.workbuddy'
  if (agent === 'doubao') return 'cliConnect.prompt.doubao'
  return 'cliConnect.prompt.noSkill'
}

/** 手动做同样的事，终端里逐行执行。安装后立刻补会话 PATH，后面的 `muvloom` 才找得到。 */
export function manualCommands(agent: ConnectAgentId, platform: ConnectPlatform): string[] {
  const skill = skillInstallCommand(agent)
  return [
    INSTALL_COMMAND[platform],
    SESSION_PATH[platform],
    ...(skill ? [skill] : []),
    'muvloom auth login',
  ]
}

/** 运行时按系统猜一个默认平台；猜不出来按类 Unix 处理。 */
export function detectPlatform(userAgent: string): ConnectPlatform {
  return /windows/i.test(userAgent) ? 'windows' : 'unix'
}
