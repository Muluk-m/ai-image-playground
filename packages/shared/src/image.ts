/** 上传与抠图接受的图片 content-type。 */
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const

/** 数的是 data URL 字符数，不是解码后的字节数。 */
export const IMAGE_DATA_URL_MAX_CHARS = 4_000_000
