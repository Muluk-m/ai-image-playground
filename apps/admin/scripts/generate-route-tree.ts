import { resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'

const root = resolve(import.meta.dir, '..')
const routesDirectory = resolve(root, 'src/routes')

const config = getConfig(
  {
    routesDirectory,
    generatedRouteTree: resolve(root, 'src/routeTree.gen.ts'),
  },
  root,
)

await new Generator({ config, root }).run()
