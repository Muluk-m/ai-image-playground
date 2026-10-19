import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closureHash, parseLock } from '../lock-closure-changed.mjs'

const lock = ({
  version = "'9.0'",
  settings = 'autoInstallPeers: true',
  web = '',
  zod = '3.24.0',
  hono = 'zod: 3.24.0',
} = {}) => `lockfileVersion: ${version}

settings:
  ${settings}

importers:

  apps/bff:
    dependencies:
      '@image-playground/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      hono:
        specifier: ^4.0.0
        version: 4.1.0

  apps/web:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.2.6
${web}
  packages/shared:
    dependencies:
      zod:
        specifier: ^3.0.0
        version: ${zod}

packages:

  hono@4.1.0:
    resolution: {integrity: sha512-hono}

  react@19.2.6:
    resolution: {integrity: sha512-react}

  virtual@3.17.0:
    resolution: {integrity: sha512-virtual}

  zod@3.24.0:
    resolution: {integrity: sha512-zod}

  zod@3.25.0:
    resolution: {integrity: sha512-zod-new}

snapshots:

  hono@4.1.0:
    dependencies:
      ${hono}

  react@19.2.6: {}

  virtual@3.17.0: {}

  zod@3.24.0: {}

  zod@3.25.0: {}
`

const webOnly = `      virtual:
        specifier: ^3.17.0
        version: 3.17.0
`
const api = (text) => closureHash(parseLock(text), ['apps/bff'])
const site = (text) => closureHash(parseLock(text), ['apps/web'])

test('a web-only dependency leaves the API closure alone', () => {
  assert.equal(api(lock()), api(lock({ web: webOnly })))
  assert.notEqual(site(lock()), site(lock({ web: webOnly })))
})

test('a transitive or linked workspace dependency change reaches the API closure', () => {
  assert.notEqual(api(lock()), api(lock({ hono: 'zod: 3.25.0' })))
  assert.notEqual(api(lock()), api(lock({ zod: '3.25.0' })))
  assert.equal(site(lock()), site(lock({ zod: '3.25.0' })))
})

test('global install settings change every closure', () => {
  const changed = lock({ settings: 'autoInstallPeers: false' })
  assert.notEqual(api(lock()), api(changed))
  assert.notEqual(site(lock()), site(changed))
})

test('unsupported or unreadable lockfiles fail instead of guessing', () => {
  assert.throws(() => parseLock(lock({ version: "'6.0'" })), /lockfileVersion/)
  assert.throws(() => parseLock(lock().replace(/\nsnapshots:[\s\S]*$/, '\n')), /snapshots/)
  assert.throws(() => api(lock({ hono: 'zod: 9.9.9' })), /not in the lockfile/)
})
