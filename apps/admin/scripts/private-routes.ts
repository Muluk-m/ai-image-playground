import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PRIVATE_ROUTE_SUFFIX = '.route.tsx'

export function stagePrivateAdminRoutes(
  routesDirectory: string,
  privateRoutesDirectory: string | null,
): string[] {
  for (const entry of readdirSync(routesDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(PRIVATE_ROUTE_SUFFIX)) {
      rmSync(join(routesDirectory, entry.name))
    }
  }
  if (!privateRoutesDirectory || !existsSync(privateRoutesDirectory)) return []

  const routeNames = readdirSync(privateRoutesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(PRIVATE_ROUTE_SUFFIX))
    .map((entry) => entry.name)
    .sort()
  for (const routeName of routeNames) {
    copyFileSync(join(privateRoutesDirectory, routeName), join(routesDirectory, routeName))
  }
  return routeNames
}
