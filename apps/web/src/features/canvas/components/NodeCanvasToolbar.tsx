import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { CreateNodeKind } from '../lib/nodeCanvasActions'

export function NodeTool({
  icon,
  label,
  onClick,
  pressed,
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant={pressed ? 'secondary' : 'ghost'}
      size="icon"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size="md" />
    </Button>
  )
}
export default function NodeCanvasToolbar({
  onCreate,
  onMenu,
  onUpload,
  onAssets,
  mode,
  onMode,
  zoom,
  onZoom,
  onFit,
  minimap,
  onMinimap,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onChat,
}: {
  onCreate: (kind: CreateNodeKind) => void
  onMenu: () => void
  onUpload: () => void
  onAssets: () => void
  mode: 'select' | 'pan'
  onMode: (mode: 'select' | 'pan') => void
  zoom: number
  onZoom: (zoom: number) => void
  onFit: () => void
  minimap: boolean
  onMinimap: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onChat?: () => void
}) {
  const { t } = useTranslation('canvas')
  return (
    <>
      <div className="studio-node-tools" role="toolbar" aria-label={t('nodes.addTitle')}>
        <NodeTool icon="add" label={t('nodes.addTitle')} onClick={onMenu} />
        <span className="studio-node-tool-divider" />
        <NodeTool icon="text" label={t('nodes.addText')} onClick={() => onCreate('text')} />
        <NodeTool icon="image" label={t('nodes.addImage')} onClick={() => onCreate('image')} />
        <NodeTool icon="video" label={t('nodes.addVideo')} onClick={() => onCreate('video')} />
        <span className="studio-node-tool-divider" />
        <NodeTool icon="folder" label={t('nodes.assets')} onClick={onAssets} />
        <NodeTool icon="upload" label={t('nodes.addUpload')} onClick={onUpload} />
      </div>
      <div className="studio-node-navigation" role="toolbar" aria-label={t('nodes.pan')}>
        <NodeTool
          icon="select"
          label={`${t('nodes.select')} (V)`}
          pressed={mode === 'select'}
          onClick={() => onMode('select')}
        />
        <NodeTool
          icon="pan"
          label={`${t('nodes.pan')} (H)`}
          pressed={mode === 'pan'}
          onClick={() => onMode('pan')}
        />
        <span className="studio-node-tool-divider" />
        <NodeTool icon="zoomOut" label={t('nodes.zoomOut')} onClick={() => onZoom(zoom / 1.2)} />
        <Button
          variant="ghost"
          className="w-14 px-0 tabular-nums"
          title={t('nodes.resetZoom')}
          onClick={() => onZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <NodeTool icon="zoomIn" label={t('nodes.zoomIn')} onClick={() => onZoom(zoom * 1.2)} />
        <NodeTool icon="fit" label={t('nodes.fit')} onClick={onFit} />
        <NodeTool icon="canvas" label={t('nodes.minimap')} pressed={minimap} onClick={onMinimap} />
      </div>
      <div className="studio-node-history" role="toolbar" aria-label={t('nodes.undo')}>
        <NodeTool icon="undo" label={t('nodes.undo')} disabled={!canUndo} onClick={onUndo} />
        <NodeTool icon="redo" label={t('nodes.redo')} disabled={!canRedo} onClick={onRedo} />
      </div>
      {onChat && (
        <Button className="studio-node-chat rounded-full" variant="secondary" onClick={onChat}>
          <Icon name="chat" />
          {t('nodes.chat')}
        </Button>
      )}
    </>
  )
}
