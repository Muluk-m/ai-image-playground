/** 文件选择器在一些系统上不给 HEIC 填 MIME；扩展名只补空值或通用二进制类型。 */
export function isHeicFile(file: File): boolean {
  return (
    /^image\/hei[cf](?:-sequence)?$/i.test(file.type) ||
    ((!file.type || file.type === 'application/octet-stream') && /\.hei[cf]$/i.test(file.name))
  )
}
