import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { PlusIcon, SparkleIcon } from '../../../components/icons'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { APP_MODE_LABELS, storeImageFromFile, useStore } from '../../../store'
import { useAgentSkills } from '../../agent/lib/useAgentSkills'
import ProjectsTab from '../../canvas/components/ProjectsTab'
import { availableImageModels } from '../lib/activeLook'
import { lookBatchEnabled } from '../lib/batchClient'
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
import BatchDialog from './BatchDialog'
import CreateRecordDialog, { handoffToAgent } from './CreateRecordDialog'
import { AssetsEmpty, NoMatch, TemplatesEmpty } from './LibraryEmpty'
import LookCard from './LookCard'
import LookDetail from './LookDetail'
import NewTile from './NewTile'
import TemplateCard from './TemplateCard'
import TemplateDetail from './TemplateDetail'

const TABS: readonly LibraryTab[] = ['projects', 'assets', 'prompts', 'looks']

const HEAD_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition'
const GHOST = `${HEAD_BUTTON} border border-border text-foreground hover:bg-muted`
const PRIMARY = `${HEAD_BUTTON} bg-primary text-primary-foreground hover:opacity-90`

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
  const [batchLook, setBatchLook] = useState<LookItem | null>(null)

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
  // 智能体创建与批量出图都要登录并开了同步：素材库在服务端才有一份，智能体才读得到。
  const agentReady = lookBatchEnabled()
  const mine = looks.filter((look) => look.origin === 'user')
  const builtin = looks.filter((look) => look.origin === 'builtin')
  // 详情里的记录随库变：改名、删除后不能还显示旧的那份。
  const liveAssetDetail = assetDetail
    ? (useLibraryStore.getState().assets.find((one) => one.id === assetDetail.id) ?? null)
    : null
  const liveLookDetail = lookDetail
    ? (looks.find((one) => one.skillName === lookDetail.skillName) ?? null)
    : null

  const tuneLook = (look: LookItem) =>
    handoffToAgent(
      look.origin === 'user'
        ? `/create-look 继续调试模板「${look.name}」`
        : `/create-look 基于预置模板「${look.name}」复制一份来改`,
    )

  const placeholder =
    tab === 'projects'
      ? t('panel.searchProjects')
      : tab === 'prompts'
        ? t('panel.searchTemplates')
        : tab === 'looks'
          ? t('panel.searchLooks')
          : t('panel.searchAssets')

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.library}</h1>
        <div className="flex items-center gap-1">
          {TABS.map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setTab(one)}
              aria-pressed={tab === one}
              className={`rounded-full px-3 py-1 text-[13px] transition-colors ${
                tab === one
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t(`tab.${one}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
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
            <button type="button" onClick={() => setCreating('asset')} className={GHOST}>
              <PlusIcon className="h-4 w-4" />
              {t('asset.new')}
            </button>
            {agentReady && (
              <button
                type="button"
                onClick={() => handoffToAgent('/create-asset ')}
                className={PRIMARY}
              >
                <SparkleIcon className="h-4 w-4" />
                {t('asset.createWithAgent')}
              </button>
            )}
          </>
        )}
        {tab === 'looks' && (
          <>
            <button type="button" onClick={() => setCreating('look')} className={GHOST}>
              <PlusIcon className="h-4 w-4" />
              {t('look.new')}
            </button>
            {agentReady && (
              <button
                type="button"
                onClick={() => handoffToAgent('/create-look ')}
                className={PRIMARY}
              >
                <SparkleIcon className="h-4 w-4" />
                {t('look.createWithAgent')}
              </button>
            )}
          </>
        )}
      </div>

      {tab === 'projects' ? (
        <ProjectsTab search={searchKeyword} />
      ) : tab === 'prompts' ? (
        <div className="min-h-0 flex-1 p-5">
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
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-5">
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
                  onGenerate={setBatchLook}
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
                    onGenerate={setBatchLook}
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
          <div className="min-h-0 flex-1 p-5">
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
            setBatchLook(look)
          }}
          onTune={tuneLook}
        />
      )}
      {batchLook && <BatchDialog look={batchLook} onClose={() => setBatchLook(null)} />}
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
