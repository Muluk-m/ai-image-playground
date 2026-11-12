/**
 * `/connect` 上每个插件宿主的接入方式。命令来自已发布的 `cli-go`（install.sh / install.ps1 与
 * `muvloom skill install`）；这里只放展示用的配置，不重复实现安装逻辑。
 * 安装细节放在 public/cli/setup.md，页面只展示可复制的短提示词。
 *
 * `muvloom skill install --host` 在当前发布里只接受 `claude-code` 与 `codex`
 * （`cli-go/internal/cli/skill.go`）。WorkBuddy 的技能目录是 `~/.workbuddy/skills/`，
 * 豆包工作在客户端「插件·技能·伙伴」里上传技能，都没有对应的 `--host`。
 * WorkBuddy 和豆包工作按专用指南在对话中安装官方技能；不生成未经当前已发布 CLI
 * 支持的 `skill install` 命令。其他宿主使用通用技能包。
 */

export const CONNECT_AGENTS = ['workbuddy', 'doubao', 'claude-code', 'codex', 'other'] as const
export type ConnectAgentId = (typeof CONNECT_AGENTS)[number]
export type ConnectPlatform = 'unix' | 'windows'
export const AGENT_SETUP_PATH = '/cli/setup.md'
export const WORKBUDDY_SETUP_PATH = '/cli/workbuddy.md'
export const DOUBAO_SETUP_PATH = '/cli/doubao.md'
export const WORKBUDDY_SKILL_PATH = '/cli/muvloom-workbuddy.zip'
export const DOUBAO_SKILL_PATH = '/cli/muvloom-doubao.zip'
export const GENERIC_SKILL_PATH = '/cli/muvloom-skill.zip'
export const INSTALL_SH_PATH = '/cli/install.sh'
export const INSTALL_PS1_PATH = '/cli/install.ps1'

const SKILL_HOSTS = new Set<ConnectAgentId>(['claude-code', 'codex'])

export type SkillPackageId = 'workbuddy' | 'doubao' | 'other'

/** 手动安装时需要下载技能包的宿主。Claude Code / Codex 用 CLI 的 skill install。 */
export function skillPackage(agent: ConnectAgentId): SkillPackageId | null {
  if (agent === 'workbuddy' || agent === 'doubao' || agent === 'other') return agent
  return null
}

export const SKILL_PACKAGE_PATH: Record<SkillPackageId, string> = {
  workbuddy: WORKBUDDY_SKILL_PATH,
  doubao: DOUBAO_SKILL_PATH,
  other: GENERIC_SKILL_PATH,
}

/**
 * 构建期常量由 `apps/web/scripts/cli-build-defines.mjs` 注入（应用、官网的 Vite 与 Vitest 配置都注入）。
 * 只有官网的 vite.config 在 Node 里直接加载指南目录取页面路径时还没有注入，这里不能抛 ReferenceError；
 * 那一步不产出页面内容。打包出的页面一定带真实值，官网测试会核对。
 */
const GUIDE_REV = typeof __CLI_GUIDE_REV__ === 'undefined' ? '' : __CLI_GUIDE_REV__

/**
 * 给智能体的指南网址。`v` 是指南和安装脚本内容的哈希：宿主抓取网页时会缓存，网址不变就可能一直读到旧指南
 * （旧指南里固定着旧的安装版本）；内容一变网址就变，旧缓存自然失效。
 */
export function guideUrl(path: string, origin: string): string {
  const url = new URL(path, origin)
  url.searchParams.set('v', GUIDE_REV)
  return url.href
}

export function agentSetupPath(agent: ConnectAgentId): string {
  if (agent === 'workbuddy') return WORKBUDDY_SETUP_PATH
  if (agent === 'doubao') return DOUBAO_SETUP_PATH
  return AGENT_SETUP_PATH
}

/**
 * 官网安装脚本随本站 `/cli/install.sh` 与 `/cli/install.ps1` 发布，并用页面里写明的 SHA-256 校验。
 * 脚本再从 GitHub releases 下载 CLI 二进制并校验其 SHA-256。发新版安装脚本时，setup.md 里的校验和
 * 必须一并更新。
 */
export const CLI_MIN_VERSION = '0.2.5'
/** 当前已发布的 CLI；未打 tag 的后续版本在指南里只作为最低版本之上的升级，不在页面上提前钉死。 */
export const CLI_VERSION = '0.2.5'
export const INSTALL_SH_SHA256 =
  typeof __CLI_INSTALL_SH_SHA256__ === 'undefined' ? '' : __CLI_INSTALL_SH_SHA256__
export const INSTALL_PS1_SHA256 =
  typeof __CLI_INSTALL_PS1_SHA256__ === 'undefined' ? '' : __CLI_INSTALL_PS1_SHA256__

/**
 * 安装脚本跑在子进程里，改不了当前终端的 PATH：安装目录不在 PATH 时，紧接着的 `muvloom`
 * 会找不到命令。Unix 尊重安装脚本的 `MUVLOOM_INSTALL_DIR`；Windows 刷新安装器写入的用户 PATH。
 */
export const SESSION_PATH: Record<ConnectPlatform, string> = {
  unix: 'export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"',
  windows:
    '$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")',
}

export function installScriptCommands(platform: ConnectPlatform, origin: string): string[] {
  if (platform === 'unix') {
    const url = guideUrl(INSTALL_SH_PATH, origin)
    return [
      'tmp="$(mktemp)"',
      `curl -fsSL "${url}" -o "$tmp"`,
      `actual="$(command -v sha256sum >/dev/null && sha256sum "$tmp" | awk '{print $1}' || shasum -a 256 "$tmp" | awk '{print $1}')"`,
      `[ "$actual" = "${INSTALL_SH_SHA256}" ] || { echo "checksum mismatch"; exit 1; }`,
      `MUVLOOM_MIN_VERSION=${CLI_MIN_VERSION} sh "$tmp"`,
    ]
  }
  const url = guideUrl(INSTALL_PS1_PATH, origin)
  return [
    '$script = Join-Path $env:TEMP "muvloom-install.ps1"',
    `Invoke-WebRequest "${url}" -OutFile $script`,
    `if ((Get-FileHash $script -Algorithm SHA256).Hash.ToLower() -ne "${INSTALL_PS1_SHA256}") { throw "checksum mismatch" }`,
    `$env:MUVLOOM_MIN_VERSION = "${CLI_MIN_VERSION}"; powershell -NoProfile -ExecutionPolicy Bypass -File $script; if ($LASTEXITCODE -ne 0) { throw "muvloom installer failed with exit code $LASTEXITCODE" }`,
  ]
}

/** 当前已发布 CLI 接受的 `muvloom skill install --host`。没有对应 host 的宿主返回 null。 */
export function skillInstallCommand(agent: ConnectAgentId): string | null {
  return SKILL_HOSTS.has(agent) ? `muvloom skill install --host ${agent}` : null
}

/** 手动做同样的事，终端里逐行执行。安装后立刻补会话 PATH，后面的 `muvloom` 才找得到。 */
export function manualCommands(
  agent: ConnectAgentId,
  platform: ConnectPlatform,
  origin = 'https://muvloom.online',
): string[] {
  const skill = skillInstallCommand(agent)
  return [
    ...installScriptCommands(platform, origin),
    SESSION_PATH[platform],
    ...(skill ? [skill] : []),
    'muvloom auth login',
  ]
}

/** 运行时按系统猜一个默认平台；猜不出来按类 Unix 处理。 */
export function detectPlatform(userAgent: string): ConnectPlatform {
  return /windows/i.test(userAgent) ? 'windows' : 'unix'
}
