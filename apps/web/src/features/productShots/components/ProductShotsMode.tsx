import { useEffect } from 'react'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'
import { useWorkflowEditor } from '../workflows/runtime'
import WorkflowGallery from '../workflows/WorkflowGallery'
import WorkflowWorkspace from '../workflows/WorkflowWorkspace'
import ActionPanel from './ActionPanel'
import BatchBar from './BatchBar'
import JobSwitcher from './JobSwitcher'
import PlanDrawer from './PlanDrawer'
import PreviewPanel from './PreviewPanel'
import ProductBar from './ProductBar'
import ResultGallery from './ResultGallery'
import SourcePanel from './SourcePanel'
import VersionBar from './VersionBar'

/** 左右两栏吸顶，只有中央栏随页面滚：版本一多，原图与设置不能跟着滚出视口。 */
const STICKY_COLUMN = 'lg:sticky lg:self-start'

export default function ProductShotsMode() {
  const session = useWorkflowEditor((s) => s.session)
  const jobId = useProductShotsStore((s) => s.draft.id)
  const imageId = useProductShotsStore((s) => s.selectedImageId)
  const activeSession = session?.jobId === jobId && session.imageId === imageId ? session : null
  useEffect(() => {
    const { loadJobs, openLatestJob } = useProductShotsStore.getState()
    void loadJobs().then(openLatestJob)
    // 重开一个换产品的任务时，右栏的素材缩略图与提交都要现成的素材记录。
    void useLibraryStore.getState().loadAssets()
  }, [])

  return (
    <main className="safe-area-x mx-auto max-w-7xl px-4 pb-24 pt-4">
      <JobSwitcher />

      <ProductBar />

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_17rem]">
        <div className={STICKY_COLUMN} style={{ top: HEADER_OFFSET }}>
          <SourcePanel />
        </div>

        {activeSession ? (
          <WorkflowWorkspace
            key={`${activeSession.jobId}:${activeSession.imageId}:${activeSession.kind}:${activeSession.versionId}:${activeSession.resultVersionId}`}
            session={activeSession}
          />
        ) : (
          <>
            <div data-product-shots-column="center" className="flex flex-col gap-4">
              <PreviewPanel />
              <VersionBar />
            </div>

            <div className={STICKY_COLUMN} style={{ top: HEADER_OFFSET }}>
              <ActionPanel />
            </div>
          </>
        )}
      </div>

      <BatchBar />
      <WorkflowGallery />
      <ResultGallery />
      <PlanDrawer />
    </main>
  )
}
