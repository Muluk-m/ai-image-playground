import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { PlusIcon, SparkleIcon } from '../../../components/icons'
import PageHeader from '../../../components/PageHeader'
import SearchField from '../../../components/SearchField'
import SegmentedTabs from '../../../components/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { APP_MODE_LABELS, storeImageFromFile, useStore } from '../../../store'
import { useAgentSkills } from '../../agent/lib/useAgentSkills'
import ProjectsTab from '../../canvas/components/ProjectsTab'
import { availableImageModels, pinLookParams } from '../lib/activeLook'
import { libraryAgentReady } from '../lib/libraryAgent'
import { type LookItem, lookNeedsRetune, matchLooksByName, mergeLookItems } from '../lib/looks'
import {
  type LibraryTab,
  selectVisibleAssets,
  selectVisibleTemplates,
  useLibraryStore,
} from '../store'
import type { AssetRecord } from '../types'
import AssetCard from './AssetCard'
import AssetDetail from './AssetDetail'
import CreateRecordDialog, { handoffToAgent } from './CreateRecordDialog'
import { AssetsEmpty, NoMatch, TemplatesEmpty } from './LibraryEmpty'
import LookCard from './LookCard'
import LookDetail from './LookDetail'
import NewTile from './NewTile'
import TemplateCard from './TemplateCard'
import TemplateDetail from './TemplateDetail'

const TABS: readonly LibraryTab[] = ['projects', 'assets', 'prompts', 'looks']

const SEARCH_PLACEHOLDER = {
  projects: 'panel.searchProjects',
  assets: 'panel.searchAssets',
  prompts: 'panel.searchTemplates',
  looks: 'panel.searchLooks',
} as const satisfies Record<LibraryTab, string>

/**
 * 「资产」入口：自己攒下的料——**项目**（画布）、**素材**（产品 / 人物的一组视角）、
 * **提示词**（存起来的一段提示词，原「模板」）与**模板**（调好的出图效果）。作品在创作页，灵感在「探索」。
 */
export default function LibraryPage() {
  const { t } = useTranslation('library')
  const tab = useLibraryStore((s) => s.tab)
  const setTab = useLibraryStore((s) => s.setTab)
  const searchKeyword = useLibraryStore((s) => s.searchKeyword)
  const setSearch = useLibraryStore((s) => s.setSearch)
  const assets = useLibraryStore(useShallow(selectVisibleAssets))
  const assetCount = useLibraryStore((s) => s.assets.length)
  const templates = useLibraryStore(useShallow(selectVisibleTemplates))
  const templateCount = useLibraryStore((s) => s.templates.length)
  const lookRecords = useLibraryStore(useShallow((s) => s.looks))
  const importAssetFiles = useLibraryStore((s) => s.importAssetFiles)
  const saveLookRecord = useLibraryStore((s) => s.saveLookRecord)
  const settings = useStore((s) => s.settings)
  const skills = useAgentSkills('image')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState<'asset' | 'look' | null>(null)
  const [assetDetail, setAssetDetail] = useState<AssetRecord | null>(null)
  const [lookDetail, setLookDetail] = useState<LookItem | null>(null)

  useEffect(() => {
    const library = useLibraryStore.getState()
    library.enterLibraryPage()
    void library.loadAssets()
    void library.loadTemplates()
    void library.loadLooks()
    return () => useLibraryStore.getState().leaveLibraryPage()
  }, [])

  // 拖进来和粘贴进来的都已经过了图片与大小筛，这里只剩「一次太多先问一声」。
  const saveAssets = (files: File[]) => {
    if (tab !== 'assets') return
    confirmImageBatch(files.length, () => void importAssetFiles(files))
  }
  const { dragging, dropZoneProps } = useImageDropZone(saveAssets)
  usePasteImageFiles('library', saveAssets)

  const openFilePicker = () => fileInputRef.current?.click()

  const looks = useMemo(
    () => matchLooksByName(mergeLookItems(lookRecords, skills), searchKeyword),
    [lookRecords, skills, searchKeyword],
  )
  const models = useMemo(() => availableImageModels(), [settings])
  // 智能体创建与用模板出图都要登录并开了同步：素材库与模板在服务端才有一份，智能体才读得到。
  const agentReady = libraryAgentReady()
  const mine = looks.filter((look) => look.origin === 'user')
  const builtin = looks.filter((look) => look.origin === 'builtin')
  // 详情里的记录随库变：改名、删除后不能还显示旧的那份。
  const liveAssetDetail = assetDetail
    ? (useLibraryStore.getState().assets.find((one) => one.id === assetDetail.id) ?? null)
    : null
  const liveLookDetail = lookDetail
    ? (looks.find((one) => one.skillName === lookDetail.skillName) ?? null)
    : null

  // 用它出图：模型与尺寸切到模板钉死的那套，`/look-…` 放进画布输入框，等用户挑素材、点发送。
  const generateWithLook = (look: LookItem) => {
    pinLookParams(look)
    handoffToAgent(`/${look.skillName} `)
  }

  const tuneLook = (look: LookItem) =>
    handoffToAgent(
      look.origin === 'user'
        ? `/create-look 继续调试模板「${look.name}」`
        : `/create-look 基于预置模板「${look.name}」复制一份来改`,
    )

  return (
    <main className="flex min-h-[calc(100dvh-var(--mobile-nav-height,0px))] flex-col">
      <PageHeader title={APP_MODE_LABELS.library}>
        <SegmentedTabs
          tabs={TABS.map((one) => ({ value: one, label: t(`tab.${one}`) }))}
          value={tab}
          onChange={setTab}
          label={APP_MODE_LABELS.library}
        />
        <SearchField
          className="ml-auto"
          value={searchKeyword}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t(SEARCH_PLACEHOLDER[tab])}
        />
        {tab === 'assets' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                // 非图片本来就会被 importAssetFiles 丢掉，先筛一遍才问得出真正的张数。
                const images = [...(event.target.files ?? [])].filter((file) =>
                  file.type.startsWith('image/'),
                )
                event.target.value = ''
                if (images.length === 0) return
                confirmImageBatch(images.length, () => void importAssetFiles(images))
              }}
            />
            <Button variant="outline" onClick={() => setCreating('asset')}>
              <PlusIcon className="h-4 w-4" />
              {t('asset.new')}
            </Button>
            {agentReady && (
              <Button onClick={() => handoffToAgent('/create-asset ')}>
                <SparkleIcon className="h-4 w-4" />
                {t('asset.createWithAgent')}
              </Button>
            )}
          </>
        )}
        {tab === 'looks' && (
          <>
            <Button variant="outline" onClick={() => setCreating('look')}>
              <PlusIcon className="h-4 w-4" />
              {t('look.new')}
            </Button>
            {agentReady && (
              <Button onClick={() => handoffToAgent('/create-look ')}>
                <SparkleIcon className="h-4 w-4" />
                {t('look.createWithAgent')}
              </Button>
            )}
          </>
        )}
      </PageHeader>

      {tab === 'projects' ? (
        <ProjectsTab search={searchKeyword} />
      ) : tab === 'prompts' ? (
        <div className="min-h-0 flex-1 p-6">
          {templates.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <TemplateCard key={template.id} template={template} />
              ))}
            </div>
          ) : templateCount > 0 ? (
            <NoMatch label={t('panel.noMatchTemplates')} />
          ) : (
            <TemplatesEmpty />
          )}
        </div>
      ) : tab === 'looks' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
          <section>
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">
              {t('look.mine')} · {mine.length}
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <NewTile
                label={t('look.new')}
                onClick={() => setCreating('look')}
                aspect="portrait"
              />
              {mine.map((look) => (
                <LookCard
                  key={look.skillName}
                  look={look}
                  needsRetune={lookNeedsRetune(look, models)}
                  canGenerate={agentReady}
                  onOpen={setLookDetail}
                  onGenerate={generateWithLook}
                  onTune={tuneLook}
                />
              ))}
            </div>
          </section>
          {builtin.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('look.builtin')} · {builtin.length}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {builtin.map((look) => (
                  <LookCard
                    key={look.skillName}
                    look={look}
                    needsRetune={lookNeedsRetune(look, models)}
                    canGenerate={agentReady}
                    onOpen={setLookDetail}
                    onGenerate={generateWithLook}
                    onTune={tuneLook}
                  />
                ))}
              </div>
            </section>
          )}
          {looks.length === 0 && searchKeyword.trim() && (
            <NoMatch label={t('panel.noMatchLooks')} />
          )}
        </div>
      ) : (
        // 落点包在滚动容器外面，高亮层才盖住看得见的那一屏，而不是随内容滚走。
        <div {...dropZoneProps} className="relative flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 p-6">
            {assets.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                <NewTile label={t('asset.new')} onClick={() => setCreating('asset')} />
                {assets.map((asset) => (
                  <AssetCard key={asset.id} asset={asset} onOpen={setAssetDetail} />
                ))}
              </div>
            ) : assetCount > 0 ? (
              <NoMatch label={t('panel.noMatchAssets')} />
            ) : (
              <AssetsEmpty onImport={openFilePicker} />
            )}
          </div>
          {dragging && <DropOverlay label={t('panel.dropToSave')} />}
        </div>
      )}

      <TemplateDetail />
      {liveAssetDetail && (
        <AssetDetail asset={liveAssetDetail} onClose={() => setAssetDetail(null)} />
      )}
      {liveLookDetail && (
        <LookDetail
          look={liveLookDetail}
          body={liveLookDetail.record?.body ?? liveLookDetail.skill?.template?.body ?? ''}
          needsRetune={lookNeedsRetune(liveLookDetail, models)}
          canGenerate={agentReady}
          onClose={() => setLookDetail(null)}
          onGenerate={(look) => {
            setLookDetail(null)
            generateWithLook(look)
          }}
          onTune={tuneLook}
        />
      )}
      {creating === 'asset' && (
        <CreateRecordDialog
          kind="asset"
          agentReady={agentReady}
          onClose={() => setCreating(null)}
          onSave={({ files, name, kind }) =>
            importAssetFiles(files, { group: true, kind, name }).then(() => undefined)
          }
        />
      )}
      {creating === 'look' && (
        <CreateRecordDialog
          kind="look"
          agentReady={agentReady}
          onClose={() => setCreating(null)}
          onSave={async ({ files, name, purpose, description }) => {
            const stored = await Promise.all(
              files.map((file) => storeImageFromFile(file, { compress: true })),
            )
            await saveLookRecord({
              name,
              description,
              purpose,
              body: '',
              model: '',
              size: '',
              slotCount: 1,
              referenceImageIds: stored.map((image) => image.id),
              coverImageId: stored[0]?.id ?? null,
            })
          }}
        />
      )}
    </main>
  )
}
