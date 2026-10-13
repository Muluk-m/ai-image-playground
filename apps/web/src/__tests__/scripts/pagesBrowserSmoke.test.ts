// @vitest-environment node

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../..')
const require = createRequire(join(root, 'package.json'))
const { serveDist, checkWorkspace } = require(join(root, 'scripts/pages-browser-smoke.cjs'))
let dist: string
let server: { origin: string; close: () => Promise<void> }
const html =
  '<div id="boot"></div><div id="root"></div><script type="module" src="/assets/main.js"></script>'
const goodScript =
  'document.getElementById("boot").remove(); document.getElementById("root").innerHTML = `<button aria-label="创作">创作</button><div aria-label="创作画布"><canvas></canvas></div>`'

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'pages-browser-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, '_redirects'), '/p/:project / 200\n/assets/ /assets 301\n')
  await writeFile(join(dist, 'index.html'), html)
  await writeFile(join(dist, 'assets/main.js'), goodScript)
  server = await serveDist(dist)
})
afterEach(async () => {
  await server.close()
  await rm(dist, { recursive: true, force: true })
})

it('serves the same entry bytes for project deep links without swallowing missing chunks', async () => {
  expect(await (await fetch(`${server.origin}/p/example`)).text()).toBe(html)
  const missing = await fetch(`${server.origin}/assets/missing.js`)
  expect(missing.status).toBe(404)
  expect(missing.headers.get('content-type')).toBe('text/plain')
  expect(await (await fetch(`${server.origin}/unlisted-route`)).text()).toBe('Not found')
  expect((await fetch(`${server.origin}/assets/`, { redirect: 'manual' })).status).toBe(301)
})

it('stops the release before Wrangler when the final build fails browser startup', async () => {
  const sandbox = join(dist, 'release')
  await mkdir(join(sandbox, 'scripts'), { recursive: true })
  await mkdir(join(sandbox, 'bin'))
  await writeFile(
    join(sandbox, 'scripts/pages-deploy.sh'),
    await readFile(join(root, 'scripts/pages-deploy.sh')),
  )
  const calls = join(sandbox, 'calls')
  await writeFile(join(sandbox, 'bin/pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\n', {
    mode: 0o755,
  })
  await writeFile(
    join(sandbox, 'scripts/pages-browser-smoke.sh'),
    '#!/bin/sh\necho "startup smoke failed" >&2\nexit 23\n',
  )
  await expect(
    promisify(execFile)(
      'sh',
      [join(sandbox, 'scripts/pages-deploy.sh'), 'web', 'public', 'fixture-project', 'main'],
      {
        env: {
          ...process.env,
          PATH: `${join(sandbox, 'bin')}:${process.env.PATH}`,
          CALLS_FILE: calls,
          BFF_ENABLED: 'false',
          EXTRA_ASSETS_DIR: '',
        },
      },
    ),
  ).rejects.toMatchObject({ code: 23 })
  expect(await readFile(calls, 'utf8')).toBe('--filter @image-playground/web build:static-host\n')
})

// The dedicated browser CI step provisions Chromium; the ordinary Vitest job remains lightweight.
describe.skipIf(!process.env.PAGES_SMOKE_RUNTIME_DIR)('Chromium startup regression', () => {
  let browser: { close(): Promise<void> }
  beforeAll(async () => {
    const { chromium } = require(
      join(process.env.PAGES_SMOKE_RUNTIME_DIR!, 'node_modules/playwright'),
    )
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })
  const check = (outputDir?: string, timeoutMs = 3000) =>
    checkWorkspace(browser, server.origin, { local: true, outputDir, timeoutMs })

  it('cold-starts both the home page and project deep link', async () => {
    await check()
  })
  it('cold-starts node mode using capability fixtures on both routes', async () => {
    await writeFile(
      join(dist, 'assets/main.js'),
      `
      const capabilities = await fetch('/api/capabilities').then(r => r.json());
      if (!capabilities['canvas:nodes']) throw new Error('Node capability missing');
      document.getElementById('boot').remove();
      document.getElementById('root').innerHTML = '<button aria-label="创作">创作</button><div aria-label="创作画布"><div class="react-flow" style="width:300px;height:300px"><button aria-label="显示小地图">显示小地图</button><div class="react-flow__minimap" style="width:100px;height:100px"></div></div></div>';
    `,
    )
    await checkWorkspace(browser, server.origin, { local: true, nodeCanvas: true, timeoutMs: 3000 })
  })
  it('rejects node mode when the project still renders only the legacy canvas', async () => {
    await expect(
      checkWorkspace(browser, server.origin, { local: true, nodeCanvas: true, timeoutMs: 800 }),
    ).rejects.toThrow('Startup smoke failed at /p/')
  })
  it('supports credentialed cross-origin anonymous startup without a real API', async () => {
    await writeFile(
      join(dist, 'assets/main.js'),
      `const response = await fetch('https://startup-api.invalid/api/auth/me', { credentials: 'include' }); if (response.status !== 401) throw new Error('Expected anonymous identity'); ${goodScript}`,
    )
    await check()
  })
  it('catches the incident: circular chunks initialize React exports too early', async () => {
    await writeFile(join(dist, 'assets/main.js'), 'import "./react.js"')
    await writeFile(
      join(dist, 'assets/react.js'),
      'import { store } from "./zustand.js"; var exports = {}; export function initialize() { exports.Activity = {}; return exports; } initialize();',
    )
    await writeFile(
      join(dist, 'assets/zustand.js'),
      'import { initialize } from "./react.js"; export const store = initialize();',
    )
    const output = join(dist, 'evidence')
    await expect(check(output)).rejects.toThrow(
      "Cannot set properties of undefined (setting 'Activity')",
    )
    const evidence = JSON.parse(await readFile(join(output, 'home-failed.json'), 'utf8'))
    expect(evidence.errors.join('\n')).toContain('react.js')
    expect((await readFile(join(output, 'home-failed.png'))).length).toBeGreaterThan(0)
  })
  it('rejects a missing dependency even when the entry script returns 200', async () => {
    await writeFile(join(dist, 'assets/main.js'), 'import "./missing-chunk.js"')
    await expect(check()).rejects.toThrow('Asset HTTP 404')
  })
  it('ignores scripts the CDN injects under /cdn-cgi/', async () => {
    // Cloudflare's bot challenge answers its own script with a 302 on live origins.
    await writeFile(
      join(dist, 'index.html'),
      `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>${html}`,
    )
    await check()
  })
  it('rejects a missing stylesheet even if the workspace mounts', async () => {
    await writeFile(
      join(dist, 'index.html'),
      `<link rel="stylesheet" href="/assets/missing.css">${html}`,
    )
    await expect(check()).rejects.toThrow('Asset HTTP 404')
  })
  it('uses system fonts for explicitly optional styles without contacting their CDN', async () => {
    const fontUrl = 'https://font-cdn.invalid/style.css'
    await writeFile(
      join(dist, 'index.html'),
      `<link rel="stylesheet" data-optional-style href="${fontUrl}">${html}`,
    )
    await checkWorkspace(browser, server.origin, {
      local: true,
      optionalStyles: [fontUrl],
      timeoutMs: 3000,
    })
  })
  it('rejects a page whose navigation mounts but startup cover remains', async () => {
    await writeFile(
      join(dist, 'assets/main.js'),
      goodScript.replace('document.getElementById("boot").remove();', ''),
    )
    await expect(check(undefined, 800)).rejects.toThrow('#boot')
  })
  it('rejects a broken direct project navigation even if the home page succeeds', async () => {
    await writeFile(
      join(dist, 'assets/main.js'),
      `if (location.pathname.startsWith('/p/')) throw new Error('project startup failed'); ${goodScript}`,
    )
    await expect(check()).rejects.toThrow('project startup failed')
  })
  it('requires the project canvas after navigation mounts', async () => {
    await writeFile(join(dist, 'assets/main.js'), goodScript.replace('<canvas></canvas>', ''))
    await expect(check(undefined, 800)).rejects.toThrow('创作画布')
  })
  it('blocks external API writes before they reach any backend', async () => {
    await writeFile(
      join(dist, 'assets/main.js'),
      `${goodScript}; fetch('https://backend.invalid/api/submit', {method:'POST'}).catch(()=>{})`,
    )
    await expect(check()).rejects.toThrow('Unexpected startup network request: POST')
  })
})
