import { resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'

const root = resolve(import.meta.dir, '..')
const config = getConfig(
  {
    routesDirectory: './src/routes',
    generatedRouteTree: './src/routeTree.gen.ts',
  },
  root,
)

await new Generator({ config, root }).run()
