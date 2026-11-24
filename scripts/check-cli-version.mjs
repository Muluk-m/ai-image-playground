#!/usr/bin/env node
// The CLI version has one source: `BundleVersion` in cli-go/internal/skill/install.go. The binary's
// `cli.Version` defaults to it (a release overrides it with the tag through -ldflags, which must
// match), the Skill version is it or a dotted hot-update patch of it, and the release workflow,
// the PR check tag and the release guide's commands name the same version. Any copy that drifts
// fails `pnpm lint` here instead of shipping a binary whose version disagrees with its Skill.
//
// Usage: node scripts/check-cli-version.mjs
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const INSTALL_GO = 'cli-go/internal/skill/install.go'
const APP_GO = 'cli-go/internal/cli/app.go'
const CHECKS_YML = '.github/workflows/cli-checks.yml'
const RELEASE_GUIDE = 'docs/agents/cli-release.md'

/** Problems with the files' versions; empty when they all agree. */
export function versionProblems(read) {
  const problems = []
  const install = read(INSTALL_GO)
  const bundle = install.match(/^const BundleVersion = "([^"]+)"/m)?.[1]
  const skill = install.match(/^const SkillVersion = "([^"]+)"/m)?.[1]
  if (!bundle || !/^\d+\.\d+\.\d+$/.test(bundle))
    return [`${INSTALL_GO}: BundleVersion must be an X.Y.Z version, found ${bundle ?? 'none'}`]
  if (!skill || !(skill === bundle || new RegExp(`^${bundle.replaceAll('.', '\\.')}\\.\\d+$`).test(skill)))
    problems.push(`${INSTALL_GO}: SkillVersion ${skill ?? 'none'} must be ${bundle} or ${bundle}.N`)

  if (!/^var Version = skill\.BundleVersion$/m.test(read(APP_GO)))
    problems.push(`${APP_GO}: Version must default to skill.BundleVersion, not a literal`)

  // cli-checks.yml has one input, release-tag, and so one `default:`.
  const tag = read(CHECKS_YML).match(/^\s*default:\s*['"]?(cli-v[^'"\s]+)['"]?\s*(?:#.*)?$/m)?.[1]
  if (tag !== `cli-v${bundle}`)
    problems.push(`${CHECKS_YML}: release-tag default ${tag ?? 'none'} must be cli-v${bundle}`)

  for (const [, version] of read(RELEASE_GUIDE).matchAll(/--version (\d+\.\d+\.\d+)/g)) {
    if (version !== bundle)
      problems.push(`${RELEASE_GUIDE}: example --version ${version} must be ${bundle}`)
  }
  return problems
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (invokedDirectly) {
  const problems = versionProblems((path) => readFileSync(path, 'utf8'))
  if (problems.length) {
    console.error(`CLI version check failed:\n${problems.map((p) => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log('CLI version check passed.')
}
