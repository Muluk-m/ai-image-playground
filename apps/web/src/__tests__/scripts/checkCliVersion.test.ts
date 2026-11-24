import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without type declarations
import { versionProblems } from '../../../../../scripts/check-cli-version.mjs'

/** A consistent set of the files the check reads, with overrides per test. */
function files(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    'cli-go/internal/skill/install.go':
      'const BundleVersion = "0.2.8"\nconst SkillVersion = "0.2.8.1"\n',
    'cli-go/internal/cli/app.go': 'var Version = skill.BundleVersion\n',
    '.github/workflows/cli-checks.yml':
      'on:\n  workflow_call:\n    inputs:\n      release-tag:\n        type: string\n        default: cli-v0.2.8\n',
    'docs/agents/cli-release.md': 'python install/build-dist.py --version 0.2.8 --output dist\n',
  }
  const all = { ...base, ...overrides }
  return (path: string) => all[path] ?? ''
}

describe('check-cli-version', () => {
  it('passes when every copy names BundleVersion', () => {
    expect(versionProblems(files())).toEqual([])
  })

  it('flags each copy that drifts', () => {
    const problems = versionProblems(
      files({
        'cli-go/internal/skill/install.go':
          'const BundleVersion = "0.2.8"\nconst SkillVersion = "0.2.7.4"\n',
        'cli-go/internal/cli/app.go': 'var Version = "0.2.8"\n',
        '.github/workflows/cli-checks.yml':
          '      release-tag:\n        type: string\n        default: cli-v0.2.7\n',
        'docs/agents/cli-release.md': 'build-dist.py --version 0.2.7\n',
      }),
    )
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toMatch(/SkillVersion 0\.2\.7\.4 must be 0\.2\.8/)
    expect(problems.join('\n')).toMatch(/release-tag default cli-v0\.2\.7 must be cli-v0\.2\.8/)
  })
})
