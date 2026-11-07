import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(webRoot, '../../cli-go/internal/skill/assets')

export function createWorkBuddySkillZip({ sourceDirectory = sourceRoot } = {}) {
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
  const sourceBody = source.slice(end + 5)
  const flowHeading = '\n## Flow\n'
  if (!sourceBody.includes(flowHeading)) throw new Error('Missing required Skill Flow section')
  const body = sourceBody.replace(
    flowHeading,
    '\n## WorkBuddy\n\nFor installation, account connection or local permission errors, first follow [WorkBuddy setup](references/workbuddy.md). Run the login command in the foreground and keep the turn open while it waits for the user.\n\n## Flow\n',
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

export function writeWorkBuddySkillZip() {
  const output = resolve(webRoot, 'public/cli/muvloom-workbuddy.zip')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, createWorkBuddySkillZip())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeWorkBuddySkillZip()
}
