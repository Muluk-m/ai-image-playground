/**
 * 直接出图是本机偏好，不随账号同步。
 * 没记下过选择时默认打开。只有用户明确关掉（存成 `'0'`）才回到逐张确认。
 */
export function readAutoSubmitPreference(stored: string | null): boolean {
  return stored !== '0'
}
