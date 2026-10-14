/**
 * 旧分享链接上的自带密钥参数。现在只识别并剥掉，不创建配置、不改设置。
 * `settings` 以前还能整包导入自定义端点，同样忽略。
 */
const URL_SETTING_KEYS = ['settings', 'apiUrl', 'apiKey', 'codexCli', 'apiMode', 'model'] as const

export function hasUrlSettingParams(searchParams: URLSearchParams): boolean {
  return URL_SETTING_KEYS.some((key) => searchParams.has(key))
}

export function clearUrlSettingParams(searchParams: URLSearchParams): void {
  for (const key of URL_SETTING_KEYS) searchParams.delete(key)
}
