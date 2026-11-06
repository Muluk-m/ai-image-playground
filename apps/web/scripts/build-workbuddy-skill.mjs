import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(webRoot, '../../cli-go/internal/skill/assets')

export function createWorkBuddySkillZip() {
  const files = {}
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (relative === 'agents') continue
      if (entry.isSymbolicLink()) throw new Error(`Skill source contains a symlink: ${relative}`)
      if (entry.isDirectory()) collect(join(directory, entry.name), relative)
      else if (entry.isFile()) files[`muvloom/${relative}`] = readFileSync(join(directory, entry.name))
    }
  }
  collect(sourceRoot)
  const source = files['muvloom/SKILL.md'].toString('utf8')
  const end = source.indexOf('\n---\n', 4)
  if (!source.startsWith('---\n') || end < 0) throw new Error('Missing Skill frontmatter')
  const metadata = [
    'display_name: 幕芽 Muvloom',
    'display_name_en: Muvloom',
    'description_zh: 使用幕芽、muya 或 muvloom 生成和编辑图片，查询任务并下载结果。',
    'description_en: Generate and edit images with Muvloom, check jobs and download results.',
    'version: 1.0.0',
    'author: Muvloom',
  ].join('\n')
  const body = source.slice(end + 5).replace(
    '## Flow',
    '## WorkBuddy\n\nFor installation, account connection or local permission errors, first follow [WorkBuddy setup](references/workbuddy.md). When it asks you to wait for the user, end the turn before continuing.\n\n## Flow',
  )
  files['muvloom/SKILL.md'] = Buffer.from(`${source.slice(0, end)}\n${metadata}\n---\n${body}`)
  files['muvloom/references/workbuddy.md'] = readFileSync(
    resolve(webRoot, 'workbuddy-skill/workbuddy.md'),
  )
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(webRoot, 'public/cli/muvloom-workbuddy.zip')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, createWorkBuddySkillZip())
}
