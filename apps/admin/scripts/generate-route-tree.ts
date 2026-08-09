import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'

const root = resolve(import.meta.dir, '..')
const privateEntry = resolve(root, '../../private/apps/admin/index.tsx')
const privateSettingsRoute = resolve(root, 'src/routes/_authed.billing.settings.tsx')

if (existsSync(privateEntry)) {
  writeFileSync(
    privateSettingsRoute,
    `import { createFileRoute } from '@tanstack/react-router'

import {
  PrivateAdminSettingsPanel,
  requirePrivateAdminRoute,
} from '@/lib/private-overlay'

export const Route = createFileRoute('/_authed/billing/settings')({
  beforeLoad: () => requirePrivateAdminRoute('/billing/settings'),
  component: PrivateAdminSettingsPanel,
})
`,
  )
} else {
  rmSync(privateSettingsRoute, { force: true })
}

const config = getConfig(
  {
    routesDirectory: './src/routes',
    generatedRouteTree: './src/routeTree.gen.ts',
  },
  root,
)

await new Generator({ config, root }).run()
