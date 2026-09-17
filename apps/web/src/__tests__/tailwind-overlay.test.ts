import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures: string[] = []

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function compileStyles(edition: 'public' | 'private' | 'explicit') {
  const root = mkdtempSync(join(tmpdir(), 'tailwind-overlay-'))
  fixtures.push(root)
  const web = join(root, 'apps/web')
  mkdirSync(web, { recursive: true })
  symlinkSync(join(webRoot, 'node_modules'), join(web, 'node_modules'), 'dir')
  writeFileSync(join(web, 'package.json'), '{"type":"module"}')
  writeFileSync(join(web, 'tailwind.config.js'), readFileSync(join(webRoot, 'tailwind.config.js')))
  writeFileSync(join(web, 'index.html'), '<div class="bg-white"></div>')

  const entry = join(
    root,
    edition === 'explicit' ? 'custom/web/index.tsx' : 'private/apps/web/index.tsx',
  )
  if (edition !== 'public') {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, 'export {}')
    writeFileSync(
      join(dirname(entry), 'AccountPanel.tsx'),
      '<div className="bg-[#101012] text-gray-950 from-violet-500/15" />',
    )
  }

  const env = { ...process.env }
  delete env.PRIVATE_WEB_OVERLAY_ENTRY
  if (edition === 'explicit') env.PRIVATE_WEB_OVERLAY_ENTRY = entry
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import postcss from 'postcss';
    import tailwind from 'tailwindcss';
    const result = await postcss([tailwind('./tailwind.config.js')]).process(
      '@tailwind utilities;', { from: undefined }
    );
    process.stdout.write(result.css);
  `,
    ],
    { cwd: web, env, encoding: 'utf8', timeout: 15000 },
  )
}

it.each([
  'private',
  'explicit',
] as const)('generates account styles for the %s overlay', (edition) => {
  const css = compileStyles(edition)
  expect(css).toContain('background-color: rgb(16 16 18 /')
  expect(css).toContain('.text-gray-950')
  expect(css).toContain('--tw-gradient-from: rgb(139 92 246 / 0.15)')
})

it('builds public styles when the overlay is absent', () => {
  const css = compileStyles('public')
  expect(css).toContain('.bg-white')
  expect(css).not.toContain('.text-gray-950')
  expect(css).not.toContain('background-color: rgb(16 16 18 /')
})
