/**
 * CLI 接入页里每个 Agent 宿主的接入方式。命令与目录约定来自 `cli-go`（install.sh / install.ps1 与
 * `muvloom skill install`）；这里只放展示用的配置，不重复实现安装逻辑。
 * 给 Agent 的提示词正文放在 locale（`auth:cliConnect.prompt.*`），命令作为插值传入，保证跟界面语言走。
 */

export type ConnectAgentId = 'claude-code' | 'codex' | 'other'
export type ConnectPlatform = 'unix' | 'windows'

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

/** 宿主对应的 `muvloom skill install --host`；其它 Agent 没有 Skill 目录，不装 Skill。 */
export function skillInstallCommand(agent: ConnectAgentId): string | null {
  return agent === 'other' ? null : `muvloom skill install --host ${agent}`
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
