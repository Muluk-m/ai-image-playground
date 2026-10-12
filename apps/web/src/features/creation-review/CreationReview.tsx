// Three layouts share the production component source. Only fixtures and the review switcher are disposable.
import { useEffect, useReducer, useRef, useState } from 'react'
import { VideoPlayer } from '../../components/assistant-ui/elements/video-player'
import BrandAvatar from '../../components/BrandAvatar'
import { CreationComposer } from '../../components/creation/CreationComposer'
import {
  type CreationLayout,
  type CreationReference,
  createCreationDraft,
  creationDraftReducer,
} from '../../components/creation/draft'
import { AssetGallery, NewProjectCard, ProjectCard } from '../../components/creation/MediaGallery'
import MediaImage from '../../components/MediaImage'
import Overlay from '../../components/patterns/Overlay'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { Input } from '../../components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { getTheme, setThemeChoice } from '../../theme'
import { reviewAssets, reviewCatalog, reviewProjects, reviewVideoUrl } from './fixtures'
import './review.css'

type Scene = 'create' | 'canvas' | 'projects' | 'video'
const sceneNames: Record<Scene, string> = {
  create: '创作首页',
  canvas: '画布创作',
  projects: '项目列表',
  video: '视频卡片',
}
const layoutNames = { A: '紧凑工具栏', B: '分层输入区', C: '侧边参数栏' }
export default function CreationReview() {
  const [draft, dispatch] = useReducer(creationDraftReducer, reviewCatalog, createCreationDraft)
  const [layout, setLayout] = useState<CreationLayout>(() => {
    const value = new URLSearchParams(location.search).get('variant')
    return value === 'B' || value === 'C' ? value : 'A'
  })
  const [scene, setScene] = useState<Scene>('create')
  const [drawer, setDrawer] = useState<'library' | 'canvas' | null>(null)
  const [scope, setScope] = useState<'session' | 'all'>('session')
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all')
  const [search, setSearch] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<CreationReference | null>(null)
  const [uploaded, setUploaded] = useState<CreationReference[]>([])
  const [toast, setToast] = useState('')
  const [dark, setDark] = useState(getTheme() === 'dark')
  const uploadUrls = useRef<string[]>([])
  const allAssets = [...reviewAssets, ...uploaded]
  const visibleAssets = allAssets.filter(
    (asset, index) =>
      (scope === 'all' || index < 4 || asset.kind === 'video' || uploaded.includes(asset)) &&
      (filter === 'all' || asset.kind === filter) &&
      asset.name.includes(search),
  )
  const visibleProjects = reviewProjects.filter(
    (p) =>
      (projectFilter === 'all' ||
        (projectFilter === 'agent' ? p.kind === 'agent' : p.kind !== 'agent')) &&
      p.name.includes(projectSearch),
  )
  useEffect(
    () => () => {
      for (const url of uploadUrls.current) URL.revokeObjectURL(url)
    },
    [],
  )
  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(timeout)
  }, [toast])
  const chooseLayout = (next: CreationLayout) => {
    setLayout(next)
    const url = new URL(location.href)
    url.searchParams.set('variant', next)
    history.replaceState(null, '', url)
  }
  const cycle = (direction: number) =>
    chooseLayout((['A', 'B', 'C'] as const)[(['A', 'B', 'C'].indexOf(layout) + direction + 3) % 3])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable], [role="dialog"], [role="listbox"]'))
        return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        cycle(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [layout])
  const openAssets = (source: 'library' | 'canvas') => {
    setDrawer(source)
    setSelected(new Set(draft.references.map((r) => r.id)))
  }
  const addSelected = () => {
    const additions = allAssets.filter(
      (asset) => selected.has(asset.id) && !draft.references.some((r) => r.id === asset.id),
    )
    dispatch({ type: 'references', references: [...draft.references, ...additions] })
    setDrawer(null)
    setToast(`已添加 ${additions.length} 个参考素材`)
  }
  const composer = (
    <CreationComposer
      draft={draft}
      dispatch={dispatch}
      catalog={reviewCatalog}
      layout={layout}
      onAssets={openAssets}
      onUpload={(files) => {
        const assets = Array.from(files)
          .filter((file) => file.type.startsWith('image/'))
          .map((file) => {
            const src = URL.createObjectURL(file)
            uploadUrls.current.push(src)
            return { id: crypto.randomUUID(), name: file.name, src, kind: 'image' as const }
          })
        setUploaded((old) => [...old, ...assets])
        dispatch({ type: 'references', references: [...draft.references, ...assets] })
      }}
      onSubmit={() => setToast('演示已提交 · 未调用生成服务，未扣费')}
    />
  )
  const projectGrid = (recent = false) => (
    <div className="review-project-grid">
      {!recent && (
        <NewProjectCard
          onCreate={() => {
            setScene('create')
            setToast('已打开创作区')
          }}
        />
      )}
      {(recent ? reviewProjects.slice(0, 4) : visibleProjects).map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          onOpen={() => {
            setScene('canvas')
            setToast(p.name)
          }}
          onMenu={() => setToast(`已选择「${p.name}」`)}
        />
      ))}
    </div>
  )
  return (
    <div className="creation-review">
      <header className="review-header">
        <Button
          variant="ghost"
          type="button"
          className="review-brand"
          onClick={() => setScene('create')}
          aria-label="Muvloom 首页"
        >
          <img src="/brand/muvloom-mark.svg" alt="" />
          <span>Muvloom</span>
        </Button>
        <nav className="review-nav" aria-label="主导航">
          <Button
            variant="ghost"
            aria-pressed={scene === 'create' || scene === 'canvas'}
            onClick={() => setScene('create')}
          >
            创作
          </Button>
          <Button
            variant="ghost"
            aria-pressed={scene === 'projects'}
            onClick={() => setScene('projects')}
          >
            项目
          </Button>
          <Button variant="ghost" onClick={() => openAssets('library')}>
            资产
          </Button>
        </nav>
        <div className="review-header-end">
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? '切换浅色' : '切换深色'}
            onClick={() => {
              setThemeChoice(dark ? 'light' : 'dark')
              setDark(!dark)
            }}
          >
            {dark ? <Icon name="light" /> : <Icon name="dark" />}
          </Button>
          <span className="review-avatar">
            <BrandAvatar />
          </span>
        </div>
      </header>
      <main className={`review-main review-scene-${scene}`}>
        {scene === 'create' && (
          <>
            <div className="review-greeting">
              <span className="review-eyebrow">MUVLOOM STUDIO</span>
              <h1>让想法，成为作品。</h1>
              <p>从一个灵感开始，创作图片、视频与更多可能。</p>
            </div>
            <div className="review-composer-wrap">{composer}</div>
            <section className="review-recent">
              <div className="review-section-heading">
                <h2>最近的项目</h2>
                <Button variant="ghost" size="sm" onClick={() => setScene('projects')}>
                  查看全部
                  <Icon name="arrowRight" />
                </Button>
              </div>
              {projectGrid(true)}
            </section>
          </>
        )}
        {scene === 'projects' && (
          <>
            <div className="review-page-title">
              <div>
                <span className="review-eyebrow">YOUR WORKSPACE</span>
                <h1>项目</h1>
              </div>
              <div className="review-project-search">
                <Icon name="search" />
                <Input
                  aria-label="搜索项目"
                  placeholder="搜索项目"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="review-project-filters">
              <div>
                {[
                  { id: 'all', label: '全部项目' },
                  { id: 'canvas', label: '画布' },
                  { id: 'agent', label: '对话' },
                ].map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    aria-pressed={projectFilter === item.id}
                    onClick={() => setProjectFilter(item.id)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setToast('演示回收站为空')}>
                <Icon name="delete" />
                回收站
              </Button>
            </div>
            {projectGrid()}
            {!visibleProjects.length && <p className="review-empty">没有匹配的项目</p>}
          </>
        )}
        {scene === 'canvas' && (
          <>
            <div className="review-canvas-heading">
              <Button
                variant="ghost"
                size="icon"
                aria-label="返回项目"
                onClick={() => setScene('projects')}
              >
                <Icon name="chevronLeft" />
              </Button>
              <span>流光香水 · 春日广告</span>
              <span className="review-saved">
                <Icon name="check" />
                已保存
              </span>
            </div>
            <div className="review-canvas-node">
              <span>
                <Icon name="image" />
                图片 1
              </span>
              <MediaImage src={reviewAssets[0].src} alt="画布中的香水产品素材" />
              <Button
                variant="ghost"
                type="button"
                aria-label="引用画布素材"
                onClick={() => {
                  dispatch({
                    type: 'references',
                    references: draft.references.some((r) => r.id === 'perfume')
                      ? draft.references
                      : [...draft.references, reviewAssets[0]],
                  })
                  setToast('已添加画布素材')
                }}
              >
                <Icon name="add" />
              </Button>
            </div>
            <div className="review-canvas-composer">{composer}</div>
          </>
        )}
        {scene === 'video' && (
          <>
            <div className="review-page-title">
              <div>
                <span className="review-eyebrow">VIDEO PREVIEW</span>
                <h1>视频作品</h1>
              </div>
            </div>
            <div className="review-video-layout">
              <article className="review-video-card">
                <VideoPlayer
                  src={reviewVideoUrl}
                  crossOrigin={null}
                  poster={reviewAssets[0].src}
                  label="香水升镜样片"
                  errorLabel="视频加载失败"
                  retryLabel="重试"
                  loadingLabel="正在加载视频"
                  aspectRatio="16 / 9"
                />
                <div className="review-video-info">
                  <h2>流光香水 · 升镜特写</h2>
                  <div className="review-video-meta">
                    <span>
                      <Icon name="video" />
                      视频
                    </span>
                    <span>
                      <Icon name="clock" />5 秒
                    </span>
                    <span>720p</span>
                    <span>16:9</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      dispatch({
                        type: 'references',
                        references: draft.references.some((r) => r.id === 'clip')
                          ? draft.references
                          : [...draft.references, reviewAssets[8]],
                      })
                      setScene('create')
                    }}
                  >
                    <Icon name="add" />
                    用作参考
                  </Button>
                </div>
              </article>
              <div className="review-video-context">
                <h2>每个作品，都从灵感开始</h2>
                <p>回到创作，继续探索下一种可能。</p>
                <Button variant="outline" onClick={() => setScene('create')}>
                  继续创作
                  <Icon name="arrowRight" />
                </Button>
              </div>
            </div>
          </>
        )}
      </main>
      {drawer && (
        <Overlay onClose={() => setDrawer(null)} layout="fill" label="资产面板">
          <aside className="review-drawer" aria-label="资产面板">
            <div className="review-drawer-top">
              <div>
                <Button
                  variant="ghost"
                  aria-pressed={scope === 'session'}
                  onClick={() => setScope('session')}
                >
                  {drawer === 'canvas' ? '画布素材' : '会话资产'}
                </Button>
                <Button
                  variant="ghost"
                  aria-pressed={scope === 'all'}
                  onClick={() => setScope('all')}
                >
                  全部资产
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭资产库"
                onClick={() => setDrawer(null)}
              >
                <Icon name="close" />
              </Button>
            </div>
            <div className="review-asset-search">
              <Icon name="search" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索素材"
                aria-label="搜索素材"
              />
            </div>
            <div className="review-asset-tabs">
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'image', label: '图片' },
                  { id: 'video', label: '视频' },
                ] as const
              ).map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <AssetGallery
              items={visibleAssets}
              selected={selected}
              onToggle={(id) =>
                setSelected((old) => {
                  const next = new Set(old)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onPreview={setPreview}
            />
            {!visibleAssets.length && <p className="review-empty">没有匹配的素材</p>}
            <footer className="review-drawer-footer">
              <span>已选 {selected.size} 项</span>
              <Button disabled={!selected.size} onClick={addSelected}>
                添加到创作
                <Icon name="arrowRight" />
              </Button>
            </footer>
          </aside>
        </Overlay>
      )}
      {preview && (
        <Overlay
          onClose={() => setPreview(null)}
          tier="raised"
          backdrop="none"
          layout="fill"
          label={preview.name}
        >
          <div className="review-preview">
            <Button
              variant="secondary"
              size="icon"
              aria-label="关闭预览"
              onClick={() => setPreview(null)}
              className="review-preview-close"
            >
              <Icon name="close" />
            </Button>
            {preview.kind === 'video' ? (
              <VideoPlayer
                src={reviewVideoUrl}
                crossOrigin={null}
                poster={preview.src}
                label={preview.name}
                errorLabel="视频加载失败"
                retryLabel="重试"
                loadingLabel="正在加载视频"
              />
            ) : (
              <MediaImage src={preview.src} alt={preview.name} />
            )}
            <span>{preview.name}</span>
          </div>
        </Overlay>
      )}
      {toast && (
        <div className="review-toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
      <div className="review-switcher" aria-label="Demo 验收工具栏">
        <span className="review-demo-label">DEMO</span>
        <Select value={scene} onValueChange={(value) => setScene(value as Scene)}>
          <SelectTrigger aria-label="验收场景">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(sceneNames).map(([value, name]) => (
              <SelectItem key={value} value={value}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="review-switcher-divider" />
        <Button variant="ghost" size="icon" aria-label="上一个布局" onClick={() => cycle(-1)}>
          <Icon name="chevronLeft" />
        </Button>
        <span className="review-layout-label">
          {layout} · {layoutNames[layout]}
        </span>
        <Button variant="ghost" size="icon" aria-label="下一个布局" onClick={() => cycle(1)}>
          <Icon name="arrowRight" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="查看验收状态">
              <Icon name="layers" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" className="review-state">
            <strong>验收清单 · 6 项</strong>
            <p>
              ① 精简输入区　② Composer 变体
              <br />③ 切换保留草稿与设置
              <br />④ 视频封面　⑤ 项目列表　⑥ 资产库
            </p>
            <p>本地演示数据；生成按钮不扣费。视频使用现有公开样片，生产黑屏原因待排查。</p>
            <details>
              <summary>当前草稿与类型设置</summary>
              <pre>{JSON.stringify(draft, null, 2)}</pre>
            </details>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
