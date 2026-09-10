import { useVideoDownload } from '../lib/useVideoDownload'
import type { VideoTask } from '../types'

export default function VideoDownloadButton({
  task,
  className,
  idleLabel,
}: {
  task: VideoTask
  className: string
  idleLabel: string
}) {
  const download = useVideoDownload(task, idleLabel)
  return (
    <button
      type="button"
      className={`${className} disabled:opacity-60`}
      disabled={download.downloading}
      onClick={() => void download.start()}
    >
      {download.label}
    </button>
  )
}
