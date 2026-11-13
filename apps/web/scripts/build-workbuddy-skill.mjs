import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(webRoot, '../../cli-go/internal/skill/assets')
const installRoot = resolve(webRoot, '../../cli-go/install')

function collectSkillFiles(sourceDirectory) {
  const files = {}
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (relative === 'agents') continue
      if (entry.isSymbolicLink()) throw new Error(`Skill source contains a symlink: ${relative}`)
      if (entry.isDirectory()) collect(join(directory, entry.name), relative)
      else if (entry.isFile())
        files[`muvloom/${relative}`] = readFileSync(join(directory, entry.name))
    }
  }
  collect(sourceDirectory)
  return files
}

function assertFrontmatter(source) {
  const end = source.indexOf('\n---\n', 4)
  if (!source.startsWith('---\n') || end < 0) throw new Error('Missing Skill frontmatter')
  return end
}

function withHostSection(source, heading, paragraph) {
  const end = assertFrontmatter(source)
  const metadata = [
    'display_name: 幕芽 Muvloom',
    'display_name_en: Muvloom',
    'description_zh: 使用幕芽、muya 或 muvloom 生成和编辑图片，查询任务并下载结果。',
    'description_en: Generate and edit images with Muvloom, check jobs and download results.',
    'version: 1.0.0',
    'author: Muvloom',
  ].join('\n')
  const sourceBody = source.slice(end + 5)
  const flowHeading = '\n## Flow\n'
  if (!sourceBody.includes(flowHeading)) throw new Error('Missing required Skill Flow section')
  const body = sourceBody.replace(flowHeading, `\n## ${heading}\n\n${paragraph}\n\n## Flow\n`)
  return Buffer.from(`${source.slice(0, end)}\n${metadata}\n---\n${body}`)
}

function zipFiles(files) {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        [bytes, { mtime: new Date(2000, 0, 1) }],
      ]),
    ),
    { level: 9 },
  )
}

export function createWorkBuddySkillZip({ sourceDirectory = sourceRoot } = {}) {
  const files = collectSkillFiles(sourceDirectory)
  const source = files['muvloom/SKILL.md'].toString('utf8')
  files['muvloom/SKILL.md'] = withHostSection(
    source,
    'WorkBuddy',
    'For installation, account connection or local permission errors, first follow [WorkBuddy setup](references/workbuddy.md). Run the login command in the foreground and keep the turn open while it waits for the user. Use the system default browser; never launch Chrome or another specific browser.',
  )
  files['muvloom/references/workbuddy.md'] = readFileSync(
    resolve(webRoot, 'workbuddy-skill/workbuddy.md'),
  )
  return zipFiles(files)
}

export function createDoubaoSkillZip({ sourceDirectory = sourceRoot } = {}) {
  const files = collectSkillFiles(sourceDirectory)
  const source = files['muvloom/SKILL.md'].toString('utf8')
  files['muvloom/SKILL.md'] = withHostSection(
    source,
    'Doubao Work',
    "For installation, account connection or local permission errors, first follow [Doubao Work setup](references/doubao.md). When the host cannot open the user's browser, print `verification_uri_complete` and wait with `auth login --timeout`. Use the system default browser; never launch Chrome, never use desktop control to open a URL, and never request elevated privileges.",
  )
  files['muvloom/references/doubao.md'] = readFileSync(resolve(webRoot, 'doubao-skill/doubao.md'))
  return zipFiles(files)
}

export function createGenericSkillZip({ sourceDirectory = sourceRoot } = {}) {
  const files = collectSkillFiles(sourceDirectory)
  const source = files['muvloom/SKILL.md'].toString('utf8')
  assertFrontmatter(source)
  return zipFiles(files)
}

export function writeWorkBuddySkillZip() {
  writeCliSkillAssets()
}

export function writeCliSkillAssets() {
  const outDir = resolve(webRoot, 'public/cli')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'muvloom-workbuddy.zip'), createWorkBuddySkillZip())
  writeFileSync(resolve(outDir, 'muvloom-doubao.zip'), createDoubaoSkillZip())
  writeFileSync(resolve(outDir, 'muvloom-skill.zip'), createGenericSkillZip())
  copyFileSync(resolve(installRoot, 'install.sh'), resolve(outDir, 'install.sh'))
  copyFileSync(resolve(installRoot, 'install.ps1'), resolve(outDir, 'install.ps1'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeCliSkillAssets()
}
