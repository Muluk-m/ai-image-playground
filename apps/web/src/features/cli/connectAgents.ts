/**
 * `/connect` 上每个插件宿主的接入方式。命令来自已发布的 `cli-go`（install.sh / install.ps1 与
 * `muvloom skill install`）；这里只放展示用的配置，不重复实现安装逻辑。
 * 安装细节放在 public/cli/setup.md，页面只展示可复制的短提示词。
 *
 * `muvloom skill install --host` 在当前发布里只接受 `claude-code` 与 `codex`
 * （`cli-go/internal/cli/skill.go`）。WorkBuddy 的技能目录是 `~/.workbuddy/skills/`，
 * 豆包工作在客户端「插件·技能·伙伴」里上传技能，都没有对应的 `--host`。
 * WorkBuddy 按专用指南在对话中安装技能；不生成未经 CLI 支持的 `skill install` 命令。
 */

export const CONNECT_AGENTS = ['workbuddy', 'doubao', 'claude-code', 'codex', 'other'] as const
export type ConnectAgentId = (typeof CONNECT_AGENTS)[number]
export type ConnectPlatform = 'unix' | 'windows'
export const AGENT_SETUP_PATH = '/cli/setup.md'
export const WORKBUDDY_SETUP_PATH = '/cli/workbuddy.md'
export const WORKBUDDY_SKILL_PATH = '/cli/muvloom-workbuddy.zip'

const SKILL_HOSTS = new Set<ConnectAgentId>(['claude-code', 'codex'])

/**
 * 给智能体的指南网址。`v` 是两份指南内容的哈希：宿主抓取网页时会缓存，网址不变就可能一直读到旧指南
 * （旧指南里固定着旧的安装版本）；内容一变网址就变，旧缓存自然失效。
 */
export function guideUrl(path: string, origin: string): string {
  const url = new URL(path, origin)
  url.searchParams.set('v', __CLI_GUIDE_REV__)
  return url.href
}

/**
 * 官方安装脚本固定到 CLI 发布对应的公开提交，而不是可移动的 `main` 或可重指向的 tag：用户复制的
 * 是已发布版本的脚本，之后分支上的改动不会悄悄变成别人电脑上的命令。脚本再校验下载的 CLI
 * SHA-256；发新版 CLI 时同时更新这两个常量。
 */
export const CLI_VERSION = '0.2.1'
export const CLI_RELEASE_REF = '78605633dc81d7d4751012eb4fe5c53a57010dda'
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
