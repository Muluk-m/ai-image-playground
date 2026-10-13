export function appVersion(): string {
  return process.env.APP_VERSION?.trim() || 'unknown'
}

/** Product release (MAJOR.MINOR.PATCH). The commit identity stays in APP_VERSION. */
export function appRelease(): string {
  return process.env.APP_RELEASE?.trim() || 'unknown'
}
