import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = resolve(webDir, 'public/cli')
const installDir = resolve(webDir, '../../cli-go/install')

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 接入指南的内容版本。给智能体复制的提示词里带着它（`?v=`）：宿主的网页抓取工具会缓存页面，
 * 指南内容变了而网址不变，用户拿到的还是旧指南里固定的旧版本命令。内容一变网址就变。
 */
function guideRevision() {
  const text = ['setup.md', 'workbuddy.md', 'doubao.md']
    .map((name) => readFileSync(resolve(cliDir, name), 'utf8'))
    .join('\n')
  const installers = Buffer.concat(
    ['install.sh', 'install.ps1'].map((name) => readFileSync(resolve(installDir, name))),
  )
  return createHash('sha256').update(text).update(installers).digest('hex').slice(0, 10)
}

/**
 * `features/cli/connectAgents.ts` 读的构建期常量。应用（apps/web）和官网（apps/website）都会打包
 * 使用指南，指南里的安装命令带着这些值，所以两边的 Vite 与 Vitest 配置都要注入同一份。
 */
export function cliBuildDefines() {
  return {
    __CLI_GUIDE_REV__: JSON.stringify(guideRevision()),
    __CLI_INSTALL_SH_SHA256__: JSON.stringify(fileSha256(resolve(installDir, 'install.sh'))),
    __CLI_INSTALL_PS1_SHA256__: JSON.stringify(fileSha256(resolve(installDir, 'install.ps1'))),
  }
}
