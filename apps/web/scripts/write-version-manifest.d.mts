import type { VersionManifest } from '../src/lib/appUpdate'

export function buildVersionManifest(
  env: Record<string, string | undefined>,
  repoRoot: string,
  now?: Date,
): VersionManifest
