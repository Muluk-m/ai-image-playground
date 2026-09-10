import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * pi 是 0.x，升级单独走 PR。同类框架有默认开启遥测、把会话内容发到厂商固定地址的先例
 * （OpenAI Agents SDK 的 tracing、Mastra 的 posthog），所以每次跟版都要重新过一遍这条。
 */

const require = createRequire(import.meta.url)

/** pi-telemetry 不导出自己的 package.json，只能顺着同 scope 的兄弟目录找。 */
function packageRoot(name: string): string {
  const [scope, bare] = name.split('/')
  if (bare === 'pi-telemetry') {
    return join(dirname(require.resolve(`${scope}/pi-agent-core/package.json`)), '..', bare)
  }
  return dirname(require.resolve(`${name}/package.json`))
}

function bundledSources(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.js')) found.push(path)
    }
  }
  walk(join(root, 'dist'))
  return found
}

function dependenciesOf(name: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(packageRoot(name), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return manifest.dependencies ?? {}
}

const ANALYTICS_VENDORS = /posthog|amplitude|mixpanel|segment\.(io|com)|sentry|datadoghq|bugsnag/i
const NETWORK_PRIMITIVES = /\bfetch\s*\(|XMLHttpRequest|new WebSocket|node:http\b|node:https\b/

describe('pi 的遥测', () => {
  it('契约包没有依赖，也就没有藏在依赖里的上报后端', () => {
    expect(dependenciesOf('@earendil-works/pi-telemetry')).toEqual({})
  })

  it('契约包自己不发网络请求', () => {
    for (const file of bundledSources(packageRoot('@earendil-works/pi-telemetry'))) {
      const source = readFileSync(file, 'utf8')
      expect({ file, network: NETWORK_PRIMITIVES.test(source) }).toEqual({ file, network: false })
      expect({ file, vendor: ANALYTICS_VENDORS.test(source) }).toEqual({ file, vendor: false })
    }
  })

  it('不给 telemetry context 时用 no-op，不是某个默认上报器', async () => {
    const { NOOP_TELEMETRY_CONTEXT } = await import('@earendil-works/pi-agent-core')
    const ran: string[] = []
    await NOOP_TELEMETRY_CONTEXT.startSpan({ name: 'probe' }, (span) => {
      span.addEvent('turn', { text: '会话内容' })
      span.setAttributes({ text: '会话内容' })
      ran.push('span')
    })
    expect(ran).toEqual(['span'])
  })

  it('运行时包的依赖里没有任何分析厂商', () => {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai']) {
      for (const dependency of Object.keys(dependenciesOf(name))) {
        expect({ name, dependency, vendor: ANALYTICS_VENDORS.test(dependency) }).toEqual({
          name,
          dependency,
          vendor: false,
        })
      }
    }
  })
})
