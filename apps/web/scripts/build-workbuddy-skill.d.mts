export function createWorkBuddySkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createDoubaoSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createGenericSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createCliSkillZip(options?: { sourceDirectory?: string }): Uint8Array
export function createSkillManifest(options?: { sourceDirectory?: string }): {
  schema_version: 1
  skill: 'muvloom'
  version: string
  bundle_version: string
  packages: Record<
    'claude-code' | 'codex' | 'workbuddy',
    {
      archive: string
      archive_sha256: string
      file_hash: string
      files: Array<{ path: string; bytes: number; sha256: string }>
    }
  >
}
export function writeWorkBuddySkillZip(): void
export function writeCliSkillAssets(): void
