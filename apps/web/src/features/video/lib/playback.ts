/** 跨域视频没配好 CORS 时 canvas 会被污染，toDataURL 直接抛。 */
export function captureVideoFrame(video: HTMLVideoElement): string | null {
  const { videoWidth: width, videoHeight: height } = video
  if (!width || !height) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  }
}
