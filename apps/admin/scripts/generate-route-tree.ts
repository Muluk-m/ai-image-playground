import { resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'
import { stagePrivateAdminRoutes } from './private-routes'

const root = resolve(import.meta.dir, '..')
const routesDirectory = resolve(root, 'src/routes')
const privateRoutesDirectory =
  process.env.PRIVATE_ADMIN_ROUTES_DIR?.trim() || resolve(root, '../../private/apps/admin/routes')

stagePrivateAdminRoutes(routesDirectory, privateRoutesDirectory)

const config = getConfig(
  {
    routesDirectory,
    generatedRouteTree: resolve(root, 'src/routeTree.gen.ts'),
  },
  root,
)

await new Generator({ config, root }).run()
