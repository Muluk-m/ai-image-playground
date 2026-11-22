export function createWorkBuddySkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createDoubaoSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createGenericSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createCliSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createSkillManifest(options?: { sourceDirectory?: string; binRoot?: string }): {
  schema_version: 1
  skill: 'muvloom'
  version: string
  bundle_version: string
  packages: Record<
    'claude-code' | 'codex' | 'workbuddy' | 'cursor' | 'windsurf' | 'cline' | 'openclaw',
    {
      archive: string
      archive_sha256: string
      file_hash: string
      files: Array<{ path: string; bytes: number; sha256: string }>
    }
  >
  cli?: {
    version: string
    binaries: Record<
      'darwin/arm64' | 'darwin/amd64' | 'linux/amd64' | 'linux/arm64' | 'windows/amd64',
      { path: string; bytes: number; sha256: string }
    >
  }
}
export function writeWorkBuddySkillZip(): void
export function writeCliSkillAssets(): void
