import { type ReactNode, useState } from 'react'
import { Hint } from '../components/assistant-ui/elements/tooltip-icon-button'
import Badge from '../components/patterns/Badge'
import { Checkbox } from '../components/patterns/Checkbox'
import ContextMenu, { ContextMenuItem } from '../components/patterns/ContextMenu'
import Dialog from '../components/patterns/Dialog'
import EmptyState from '../components/patterns/EmptyState'
import PageHeader from '../components/patterns/PageHeader'
import SearchField from '../components/patterns/SearchField'
import SectionHeader from '../components/patterns/SectionHeader'
import SegmentedTabs from '../components/patterns/SegmentedTabs'
import PatternSelect from '../components/patterns/Select'
import { SettingRow } from '../components/patterns/SettingRow'
import { Switch } from '../components/patterns/Switch'
import { Button } from '../components/ui/button'
import { ICON_SIZE_PX, ICONS, Icon, type IconName, type IconSize } from '../components/ui/icon'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../components/ui/sheet'
import { Slider } from '../components/ui/slider'
import { Textarea } from '../components/ui/textarea'
import { useTheme } from '../theme/useTheme'

/**
 * 设计系统陈列页（开发服务器上的 /design.html）：每个原语与组合件的全部变体各摆一次，
 * 新增或改动组件后在这里浅色深色各看一眼。文案是陈列用的，不进语料。
 */
export default function DesignGallery() {
  const { theme, setChoice } = useTheme()
  return (
    <div className="h-dvh overflow-y-auto bg-background text-foreground">
      <PageHeader title="幕芽设计系统">
        <div className="ml-auto flex items-center gap-2">
          <span className="text-body-sm text-muted-foreground">深色</span>
          <Switch
            checked={theme === 'dark'}
            onChange={(dark) => setChoice(dark ? 'dark' : 'light')}
            aria-label="切换深色"
          />
        </div>
      </PageHeader>
      <main className="mx-auto flex max-w-6xl flex-col gap-12 p-6">
        <Tokens />
        <Buttons />
        <Icons />
        <Forms />
        <Patterns />
        <Floating />
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionHeader title={title} />
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 shrink-0 font-mono text-label-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

const COLORS = [
  ['background', 'bg-background'],
  ['card', 'bg-card'],
  ['secondary', 'bg-secondary'],
  ['accent', 'bg-accent'],
  ['primary', 'bg-primary'],
  ['muted-foreground', 'bg-muted-foreground'],
  ['border', 'bg-border'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['destructive', 'bg-destructive'],
] as const

const TYPE_SCALE = [
  ['display 38', 'text-display'],
  ['headline 28', 'text-headline'],
  ['title-lg 20', 'text-xl'],
  ['title-md 16', 'text-base'],
  ['title-sm 15', 'text-title'],
  ['body-md 14', 'text-sm'],
  ['body-sm 13', 'text-body-sm'],
  ['label-md 12', 'text-xs'],
  ['label-sm 11', 'text-label-sm'],
] as const

const RADII = [
  ['sm', 'rounded-sm'],
  ['md', 'rounded-md'],
  ['lg', 'rounded-lg'],
  ['xl', 'rounded-xl'],
  ['2xl', 'rounded-2xl'],
  ['3xl', 'rounded-3xl'],
  ['full', 'rounded-full'],
] as const

function Tokens() {
  return (
    <Section title="Token">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {COLORS.map(([name, swatch]) => (
          <div key={name} className="flex flex-col gap-2">
            <div className={`h-12 rounded-lg ring-1 ring-hairline ${swatch}`} />
            <span className="font-mono text-label-sm text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {TYPE_SCALE.map(([name, size]) => (
          <Row key={name} label={name}>
            <span className={size}>用想象，创造更多可能 Muvloom</span>
          </Row>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        {RADII.map(([name, radius]) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <div className={`h-12 w-12 border border-border bg-card ${radius}`} />
            <span className="font-mono text-label-sm text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

const VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
const TEXT_SIZES = ['xs', 'sm', 'default', 'lg'] as const
const ICON_SIZES = ['icon-xs', 'icon-sm', 'icon', 'icon-lg'] as const

function Buttons() {
  return (
    <Section title="Button">
      {VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          {TEXT_SIZES.map((size) => (
            <Button key={size} variant={variant} size={size}>
              <Icon name="generate" />
              {size}
            </Button>
          ))}
          <Button variant={variant} disabled>
            禁用
          </Button>
        </Row>
      ))}
      <Row label="icon">
        {ICON_SIZES.map((size) => (
          <Hint key={size} tooltip={size}>
            <Button variant="outline" size={size} aria-label={size}>
              <Icon name="download" />
            </Button>
          </Hint>
        ))}
      </Row>
    </Section>
  )
}

function Icons() {
  const names = Object.keys(ICONS) as IconName[]
  return (
    <Section title="Icon">
      {(Object.keys(ICON_SIZE_PX) as IconSize[]).map((size) => (
        <Row key={size} label={`${size} ${ICON_SIZE_PX[size]}`}>
          {names.map((name) => (
            <Hint key={name} tooltip={name}>
              <span className="grid size-8 place-items-center rounded-md text-foreground hover:bg-muted">
                <Icon name={name} size={size} label={name} />
              </span>
            </Hint>
          ))}
        </Row>
      ))}
      <Row label="filled 20">
        {names.map((name) => (
          <Hint key={name} tooltip={`${name} filled`}>
            <span className="grid size-8 place-items-center rounded-md text-primary hover:bg-muted">
              <Icon name={name} size="md" filled label={name} />
            </span>
          </Hint>
        ))}
      </Row>
    </Section>
  )
}

function Forms() {
  const [checked, setChecked] = useState(true)
  const [on, setOn] = useState(false)
  const [format, setFormat] = useState('png')
  const [preset, setPreset] = useState<string | number>('a')
  return (
    <Section title="表单">
      <div className="grid max-w-xl gap-4">
        <div className="grid gap-2">
          <Label htmlFor="gallery-input">单行输入</Label>
          <Input id="gallery-input" placeholder="占位文字" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="gallery-textarea">多行输入</Label>
          <Textarea id="gallery-textarea" placeholder="占位文字" />
        </div>
        <SearchField placeholder="搜索" />
        <Select value={format} onValueChange={setFormat}>
          <SelectTrigger aria-label="格式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="png">PNG</SelectItem>
            <SelectItem value="jpeg">JPEG</SelectItem>
            <SelectItem value="webp">WebP</SelectItem>
          </SelectContent>
        </Select>
        <PatternSelect
          label="预设"
          value={preset}
          onChange={setPreset}
          options={[
            { label: '预设 A', value: 'a' },
            { label: '预设 B', value: 'b' },
          ]}
          wrapperClassName="relative h-9 w-full rounded-md border border-input px-3 text-sm"
        />
        <Checkbox checked={checked} onChange={setChecked} label="勾选框" />
        <Checkbox checked={checked} onChange={setChecked} label="会清掉数据的勾选" tone="danger" />
        <SettingRow
          icon={<Icon name="generate" />}
          label="一行设置"
          hint="补充说明"
          control={<Switch checked={on} onChange={setOn} aria-label="一行设置" />}
        />
        <Slider defaultValue={[40]} max={100} step={1} aria-label="滑块" />
      </div>
    </Section>
  )
}

function Patterns() {
  const [tab, setTab] = useState<'all' | 'image' | 'video'>('all')
  return (
    <Section title="组合件">
      <SegmentedTabs
        label="类型"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'all', label: '全部' },
          { value: 'image', label: '图片' },
          { value: 'video', label: '视频' },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        {(['neutral', 'overlay', 'primary', 'success', 'warning', 'info'] as const).map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>
      <SectionHeader title="区块标题" action={{ label: '查看全部', onClick: () => {} }} />
      <div className="rounded-2xl border border-border">
        <EmptyState
          icon={<Icon name="images" size="lg" />}
          title="这里会放你生成的作品"
          action={<Button size="sm">开始创作</Button>}
        />
      </div>
    </Section>
  )
}

function Floating() {
  const [dialog, setDialog] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <Section title="浮层">
      <div className="flex flex-wrap gap-3">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Popover</Button>
          </PopoverTrigger>
          <PopoverContent className="text-sm">贴着触发点弹出的卡片。</PopoverContent>
        </Popover>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Sheet</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>侧边面板</SheetTitle>
            </SheetHeader>
          </SheetContent>
        </Sheet>
        <Button variant="outline" onClick={() => setDialog(true)}>
          Dialog 对话框
        </Button>
        <Button
          variant="outline"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ x: box.left, y: box.bottom + 4 })
          }}
        >
          ContextMenu
        </Button>
        <Hint tooltip="悬停提示">
          <Button variant="ghost" size="icon-sm" aria-label="悬停提示">
            <Icon name="link" />
          </Button>
        </Hint>
      </div>
      {dialog && (
        <Dialog
          title="对话框标题"
          onClose={() => setDialog(false)}
          footer={
            <>
              <Button variant="outline" size="sm" onClick={() => setDialog(false)}>
                取消
              </Button>
              <Button size="sm" onClick={() => setDialog(false)}>
                确认
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">正文可滚动，左右内边距 24px。</p>
        </Dialog>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <ContextMenuItem icon={<Icon name="copy" />} label="复制" onClick={() => setMenu(null)} />
          <ContextMenuItem
            icon={<Icon name="delete" />}
            label="删除"
            onClick={() => setMenu(null)}
          />
        </ContextMenu>
      )}
    </Section>
  )
}
