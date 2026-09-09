import { onTestFinished, vi } from 'vitest'

/** 抠图失败会往控制台写一行 `[matte]`，用例自己接住它。 */
export function silenceMatteLog() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => warn.mockRestore())
  return warn
}
