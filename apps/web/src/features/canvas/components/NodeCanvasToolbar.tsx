import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { Slider } from '../../../components/ui/slider'
import { useTranslation } from '../../../i18n'
import { cn } from '../../../lib/utils'
import type { CreateNodeKind } from '../lib/nodeCanvasActions'

export function NodeTool({
  icon,
  label,
  onClick,
  pressed,
  disabled,
  className,
}: {
  icon: IconName
  label: string
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
  className?: string
}) {
  return (
    <Hint tooltip={label}>
      <Button
        type="button"
        variant="ghost"
        className={cn('aria-pressed:bg-accent aria-pressed:text-accent-foreground', className)}
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size="md" />
      </Button>
    </Hint>
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
  connections,
  onConnections,
  onArrange,
  canArrange,
  arranging,
  onKeepArrangement,
  onRevertArrangement,
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
  connections: boolean
  onConnections: () => void
  onArrange: () => void
  canArrange: boolean
  arranging: boolean
  onKeepArrangement: () => void
  onRevertArrangement: () => void
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
        <NodeTool
          icon="storyboard"
          label={t('storyboard.title')}
          onClick={() => onCreate('storyboard')}
        />
        <NodeTool icon="list" label={t('timeline.title')} onClick={() => onCreate('timeline')} />
        <span className="studio-node-tool-divider" />
        <NodeTool icon="folder" label={t('nodes.assets')} onClick={onAssets} />
        <NodeTool icon="upload" label={t('nodes.addUpload')} onClick={onUpload} />
      </div>
      <div className="studio-node-navigation" role="toolbar" aria-label={t('nodes.canvasTools')}>
        {arranging && (
          <div className="studio-node-arrange-confirm" role="status">
            <p className="text-sm">{t('nodes.keepArrangement')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onRevertArrangement}>
                {t('nodes.revertArrangement')}
              </Button>
              <Button variant="secondary" size="sm" onClick={onKeepArrangement}>
                {t('nodes.applyArrangement')}
              </Button>
            </div>
          </div>
        )}
        <NodeTool icon="undo" label={t('nodes.undo')} disabled={!canUndo} onClick={onUndo} />
        <NodeTool icon="redo" label={t('nodes.redo')} disabled={!canRedo} onClick={onRedo} />
        <span className="studio-node-tool-divider" />
        <NodeTool
          icon={mode === 'select' ? 'select' : 'pan'}
          label={mode === 'select' ? `${t('nodes.pan')} (H)` : `${t('nodes.select')} (V)`}
          onClick={() => onMode(mode === 'select' ? 'pan' : 'select')}
        />
        <span className="studio-node-tool-divider" />
        <NodeTool
          icon="link"
          label={t(connections ? 'nodes.hideConnections' : 'nodes.showConnections')}
          pressed={connections}
          onClick={onConnections}
        />
        <NodeTool
          icon="canvas"
          label={t(minimap ? 'nodes.hideMinimap' : 'nodes.showMinimap')}
          pressed={minimap}
          className="studio-node-tool-optional"
          onClick={onMinimap}
        />
        <NodeTool
          icon="grid"
          label={t('nodes.arrange')}
          pressed={arranging}
          disabled={!canArrange}
          onClick={onArrange}
        />
        <NodeTool
          icon="fit"
          label={t('nodes.fit')}
          className="studio-node-tool-optional"
          onClick={onFit}
        />
        <span className="studio-node-tool-divider" />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="studio-node-zoom-trigger tabular-nums"
              aria-label={t('nodes.zoomMenu')}
            >
              {Math.round(zoom * 100)}% <Icon name="chevronDown" size="xs" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" side="top" align="start" sideOffset={12}>
            <div className="flex items-center gap-3">
              <NodeTool
                icon="zoomOut"
                label={t('nodes.zoomOut')}
                onClick={() => onZoom(zoom / 1.2)}
              />
              <Slider
                aria-label={t('nodes.zoomMenu')}
                min={Math.log2(0.05)}
                max={3}
                step={0.05}
                value={[Math.log2(zoom)]}
                onValueChange={([value]) => onZoom(2 ** value!)}
              />
              <NodeTool
                icon="zoomIn"
                label={t('nodes.zoomIn')}
                onClick={() => onZoom(zoom * 1.2)}
              />
            </div>
            <div className="mt-2 flex gap-1">
              {[0.25, 0.5, 1, 2].map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  className="flex-1 tabular-nums"
                  onClick={() => onZoom(value)}
                >
                  {value * 100}%
                </Button>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={onFit}>
              <Icon name="fit" />
              {t('nodes.fit')}
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      {onChat && (
        <Button
          className="studio-node-chat rounded-full"
          variant="secondary"
          aria-label={t('nodes.chat')}
          onClick={onChat}
        >
          <span className="studio-node-chat-mark" aria-hidden="true">
            <img src="/brand/muvloom-mark.svg" alt="" />
          </span>
          <span className="studio-node-chat-label">{t('nodes.chat')}</span>
        </Button>
      )}
    </>
  )
}
