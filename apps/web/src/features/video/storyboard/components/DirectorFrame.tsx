import Pending from '../../../../components/Pending'
import { useStore } from '../../../../store'
import AssetThumb from '../../../library/components/AssetThumb'
import type { StoryboardShotRecord } from '../types'

export default function DirectorFrame({ shot }: { shot: StoryboardShotRecord }) {
  const task = useStore((state) => state.tasks.find((item) => item.id === shot.imageTaskId))
  return (
    <div className="vd-frame">
      {shot.imageId ? (
        <AssetThumb imageId={shot.imageId} alt={shot.title} />
      ) : (
        <div className="vd-placeholder">
          {task?.status === 'error' ? (
            '出图失败，可重新生成'
          ) : task && task.status !== 'done' ? (
            <Pending label="分镜图生成中" startedAt={task.createdAt} />
          ) : (
            '待生成分镜图'
          )}
        </div>
      )}
    </div>
  )
}
