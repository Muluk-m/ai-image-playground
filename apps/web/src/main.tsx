import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapLocale, i18next } from './i18n'
import './index.css'
import { loadRuntimeConfig } from './lib/runtimeConfig'
import { installMobileViewportGuards } from './lib/viewport'
import { initTheme } from './theme'

installMobileViewportGuards()

/**
 * 启动链原本是串的：JS → 运行时配置 → 分片 → 能力/频道 → 首帧。每一环都是一个往返，
 * 冷启动整屏黑 3.8s。这里把不依赖配置的两件事（首帧分片、语料）在第一行就发出去，
 * 与配置请求并行；闪屏由 index.html 负责，挂载时摘掉。
 */
const gateModules = Promise.all([
  import('./auth/AuthGate'),
  import('./lib/channels/bootstrapChannels'),
  import('./lib/clientCapabilities'),
])
const localeReady = bootstrapLocale()

function dismissBootSplash(): void {
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('is-done')
  // Keep the recovery UI available until the lazy workspace actually commits.
}

// Capabilities and channel discovery share one startup round trip. The channel request can return
// 401 before login; AuthGate retries it after establishing an authenticated session.
const runtime = await loadRuntimeConfig()
// 首帧的明暗已由 index.html 里的内联脚本定好；这里接手后续变化。
initTheme()
const [auth, { preloadChannels }, { bootstrapClientCapabilities }] = await gateModules
// 频道清单只决定模型下拉里有什么，首帧不等它；能力决定登录页还是工作台，必须等。
preloadChannels(runtime.bff.enabled, runtime.bff.baseUrl)
const root = createRoot(document.getElementById('root')!)
async function mountAfterCapabilities(): Promise<void> {
  try {
    // 英文语料是按需 chunk，首帧之前就得落地，否则登录页会先闪一遍中文。
    await Promise.all([
      localeReady,
      bootstrapClientCapabilities(runtime.bff.enabled, runtime.bff.baseUrl, true),
    ])
    root.render(
      <StrictMode>
        <auth.AuthGate />
      </StrictMode>,
    )
  } catch {
    root.render(
      <auth.ProblemScreen
        title={i18next.t('status.unavailableTitle', { ns: 'auth' })}
        description={i18next.t('status.unavailableDescription', { ns: 'auth' })}
        retry={() => {
          root.render(<auth.LoadingScreen />)
          void mountAfterCapabilities()
        }}
      />,
    )
  }
  dismissBootSplash()
}
void mountAfterCapabilities()
