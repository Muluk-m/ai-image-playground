import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stagePrivateAdminRoutes } from '../../../scripts/private-routes'

const workspaces: string[] = []

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true })
  }
})

describe('stagePrivateAdminRoutes', () => {
  it('replaces stale generated routes with the available private route files', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'admin-private-routes-'))
    workspaces.push(workspace)
    const routesDirectory = join(workspace, 'routes')
    const privateRoutesDirectory = join(workspace, 'private-routes')
    mkdirSync(routesDirectory)
    mkdirSync(privateRoutesDirectory)
    writeFileSync(join(routesDirectory, 'stale.route.tsx'), 'stale')
    writeFileSync(join(routesDirectory, 'public.tsx'), 'public')
    writeFileSync(join(privateRoutesDirectory, 'private.route.tsx'), 'private')
    writeFileSync(join(privateRoutesDirectory, 'ignored.txt'), 'ignored')

    expect(stagePrivateAdminRoutes(routesDirectory, privateRoutesDirectory)).toEqual([
      'private.route.tsx',
    ])
    expect(readFileSync(join(routesDirectory, 'private.route.tsx'), 'utf8')).toBe('private')
    expect(readFileSync(join(routesDirectory, 'public.tsx'), 'utf8')).toBe('public')
    expect(() => readFileSync(join(routesDirectory, 'stale.route.tsx'), 'utf8')).toThrow()
  })

  it('removes stale generated routes when the private tree is absent', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'admin-public-routes-'))
    workspaces.push(workspace)
    const routesDirectory = join(workspace, 'routes')
    mkdirSync(routesDirectory)
    writeFileSync(join(routesDirectory, 'stale.route.tsx'), 'stale')

    expect(stagePrivateAdminRoutes(routesDirectory, join(workspace, 'missing'))).toEqual([])
    expect(() => readFileSync(join(routesDirectory, 'stale.route.tsx'), 'utf8')).toThrow()
  })
})
