import Pending from '../../../../components/Pending'
import { useTranslation } from '../../../../i18n'
import { useStore } from '../../../../store'
import AssetThumb from '../../../library/components/AssetThumb'
import type { StoryboardShotRecord } from '../types'

export default function DirectorFrame({ shot }: { shot: StoryboardShotRecord }) {
  const { t } = useTranslation('video')
  const task = useStore((state) => state.tasks.find((item) => item.id === shot.imageTaskId))
  return (
    <div className="vd-frame">
      {shot.imageId ? (
        <AssetThumb imageId={shot.imageId} alt={shot.title} />
      ) : (
        <div className="vd-placeholder">
          {task?.status === 'error' ? (
            t('directorFrame.failed')
          ) : task && task.status !== 'done' ? (
            <Pending label={t('shared.shotImagePending')} startedAt={task.createdAt} />
          ) : (
            t('directorFrame.idle')
          )}
        </div>
      )}
    </div>
  )
}
