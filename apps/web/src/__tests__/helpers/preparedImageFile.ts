import { IMAGE_PREPROCESSING } from '../../lib/imagePreprocessing/policy'

/** Transport/UI fixtures exercise durable ownership and upload failures, not browser codecs. */
export async function preparedImageFile(file: File) {
  if (file.size > IMAGE_PREPROCESSING.maxInputBytes) throw new Error('attachment_input_too_large')
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('attachment_read_failed'))
    reader.readAsArrayBuffer(file)
  })
  return {
    data,
    contentType: file.type || 'image/png',
    width: 1,
    height: 1,
    originalBytes: file.size,
  }
}
