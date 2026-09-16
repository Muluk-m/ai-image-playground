import { installSourceBridge } from './lib/localCompatibility/bridge'
import { loadRuntimeConfig } from './lib/runtimeConfig'

const runtime = await loadRuntimeConfig()
if (runtime.localCompatibility) installSourceBridge(runtime.localCompatibility)
