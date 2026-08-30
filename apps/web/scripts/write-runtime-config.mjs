// 为「前端独立托管」形态（Cloudflare Pages 等纯静态宿主）在构建期生成 runtime-config.json。
//
// 容器形态不用这个脚本：镜像里的 runtime-config.json 由 scripts/docker-entrypoint.sh
// 在容器启动时写，改配置不必重新构建。纯静态宿主没有 entrypoint，只能构建期落盘。
//
// 协议见 packages/shared/src/runtime-config.ts。这里不 import 该模块：Pages 构建环境
// 只有 node，跑不了 workspace 里的 TypeScript 源码。
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseBoolean(name, raw) {
  if (raw === undefined || raw === '') return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

/**
 * 由环境变量构造 RuntimeConfig。配置不完整时抛错让构建失败——比部署出一个连不上
 * 后端的站点要好。
 */
export function buildRuntimeConfig(env) {
  const enabled = parseBoolean('BFF_ENABLED', env.BFF_ENABLED)
  const baseUrl = (env.BFF_BASE_URL ?? '').trim().replace(/\/+$/, '')

  if (!enabled) {
    if (baseUrl) throw new Error('BFF_BASE_URL is set but BFF_ENABLED is not true')
    return { bff: { enabled: false, baseUrl: '' } }
  }

  if (!baseUrl) {
    throw new Error(
      'BFF_BASE_URL is required when BFF_ENABLED=true: a statically hosted frontend is never same-origin with the BFF',
    )
  }

  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`BFF_BASE_URL must be an absolute URL, got ${JSON.stringify(baseUrl)}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`BFF_BASE_URL must be http or https, got ${parsed.protocol}`)
  }
  if (parsed.search || parsed.hash) {
    throw new Error('BFF_BASE_URL must not carry a query string or fragment')
  }

  return { bff: { enabled: true, baseUrl } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = buildRuntimeConfig(process.env)
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const outDir = process.env.RUNTIME_CONFIG_DIR ?? join(scriptDir, '..', 'dist')
  const outFile = join(outDir, 'runtime-config.json')

  await mkdir(outDir, { recursive: true })
  await writeFile(outFile, `${JSON.stringify(config, null, 2)}\n`)
  console.log(
    `✓ 已写 runtime config → ${outFile}（bff.enabled=${config.bff.enabled}, bff.baseUrl=${JSON.stringify(config.bff.baseUrl)}）`,
  )
}
