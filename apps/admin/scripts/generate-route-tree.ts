import { dirname, resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'
import { stagePrivateAdminRoutes } from './private-routes'

const root = resolve(import.meta.dir, '..')
const routesDirectory = resolve(root, 'src/routes')
const privateOverlayEntry = process.env.PRIVATE_ADMIN_OVERLAY_ENTRY?.trim()
const privateRoutesDirectory = privateOverlayEntry
  ? resolve(dirname(privateOverlayEntry), 'routes')
  : null

stagePrivateAdminRoutes(routesDirectory, privateRoutesDirectory)

const config = getConfig(
  {
    routesDirectory,
    generatedRouteTree: resolve(root, 'src/routeTree.gen.ts'),
  },
  root,
)

await new Generator({ config, root }).run()
