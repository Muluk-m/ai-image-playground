import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'

const CONFIG_KEYS = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_KEY_2',
  'GIT_CONFIG_VALUE_2',
] as const

/**
 * 用环境变量把签名打开。`git -c` 压过这层配置。
 * `commit` 必须走测试自己的 git helper。签名程序以 1 退出，
 * 仍继承 commit.gpgsign 的 helper 会让这次提交失败，而不是假装通过。
 */
export function expectCommitIgnoresSigner(commit: () => void): void {
  const root = mkdtempSync(join(tmpdir(), 'aip-nosign-'))
  const mark = join(root, 'called')
  const signer = join(root, 'signer.sh')
  writeFileSync(signer, `#!/bin/sh\necho called > ${JSON.stringify(mark)}\nexit 1\n`)
  chmodSync(signer, 0o755)
  const previous = new Map(CONFIG_KEYS.map((key) => [key, process.env[key]]))
  process.env.GIT_CONFIG_COUNT = '3'
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
  process.env.GIT_CONFIG_KEY_1 = 'gpg.format'
  process.env.GIT_CONFIG_VALUE_1 = 'ssh'
  process.env.GIT_CONFIG_KEY_2 = 'gpg.ssh.program'
  process.env.GIT_CONFIG_VALUE_2 = signer
  try {
    commit()
    expect(existsSync(mark)).toBe(false)
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}
