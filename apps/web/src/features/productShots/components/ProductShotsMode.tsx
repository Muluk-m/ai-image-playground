import { useEffect } from 'react'
import { useLibraryStore } from '../../library/store'
import { useProductShotsStore } from '../store'
import ActionPanel from './ActionPanel'
import BatchBar from './BatchBar'
import JobSwitcher from './JobSwitcher'
import PlanDrawer from './PlanDrawer'
import PreviewPanel from './PreviewPanel'
import ProductBar from './ProductBar'
import ResultGallery from './ResultGallery'
import SourcePanel from './SourcePanel'

export default function ProductShotsMode() {
  useEffect(() => {
    void useProductShotsStore.getState().loadJobs()
    // 重开一个换产品的任务时，右栏的素材缩略图与提交都要现成的素材记录。
    void useLibraryStore.getState().loadAssets()
  }, [])

  return (
    <main className="safe-area-x mx-auto max-w-7xl px-4 pb-24 pt-4">
      <JobSwitcher />

      <ProductBar />

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_17rem]">
        <SourcePanel />
        <PreviewPanel />
        <ActionPanel />
      </div>

      <BatchBar />
      <ResultGallery />
      <PlanDrawer />
    </main>
  )
}
