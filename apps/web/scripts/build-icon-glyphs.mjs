#!/usr/bin/env node
/**
 * 生成 src/components/ui/icon/glyphs.gen.ts：语义名 → 图形（线性款 + 选中用的双色款）。
 * 图形取自 Solar（480 Design，CC BY 4.0）；Solar 缺的几个取自 lucide（ISC），线宽统一到 1.5。
 * 换图形、加名字都改下面的 GLYPHS，再运行：node scripts/build-icon-glyphs.mjs
 * 新增名字后同步补 docs/design-system/icons.md 的语义名表（icon.test.tsx 会查）。
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 语义名: [来源, 图形名]。来源 solar 取 `-linear` 与 `-bold-duotone`，lucide 只有线性款。 */
const GLYPHS = {
  // 导航
  create: ['solar', 'magic-stick-3'],
  explore: ['solar', 'compass'],
  assets: ['solar', 'album'],
  toolbox: ['solar', 'toolbox'],
  guide: ['solar', 'book'],
  chat: ['solar', 'chat-round'],
  canvas: ['solar', 'frame'],
  settings: ['solar', 'settings'],
  user: ['solar', 'user-circle'],
  logout: ['solar', 'logout'],
  sidebar: ['solar', 'sidebar'],
  light: ['solar', 'sun'],
  dark: ['solar', 'moon'],
  system: ['lucide', 'monitor'],
  language: ['solar', 'global'],
  // 会员等级
  membershipFree: ['lucide', 'sprout'],
  membershipBasic: ['solar', 'stars'],
  membershipPlus: ['solar', 'star'],
  membershipMax: ['solar', 'crown-line'],
  // 创作
  generate: ['solar', 'stars'],
  wand: ['solar', 'magic-wand'],
  model: ['solar', 'cpu'],
  ratio: ['solar', 'crop-minimalistic'],
  quality: ['solar', 'crown-line'],
  settingsAdjust: ['solar', 'tuning'],
  imageAdd: ['solar', 'gallery-add'],
  attach: ['solar', 'paperclip'],
  send: ['solar', 'arrow-up'],
  shortcut: ['solar', 'keyboard'],
  clear: ['solar', 'text-cross'],
  stop: ['solar', 'stop'],
  refresh: ['solar', 'refresh'],
  speed: ['solar', 'bolt'],
  security: ['solar', 'shield-check'],
  back: ['solar', 'arrow-left'],
  upscale: ['solar', 'maximize-square'],
  removeBg: ['solar', 'scissors'],
  brush: ['solar', 'paint-brush'],
  crop: ['solar', 'crop'],
  outpaint: ['solar', 'maximize-square-2'],
  variant: ['solar', 'shuffle'],
  template: ['solar', 'bookmark'],
  favorite: ['solar', 'star'],
  reuse: ['solar', 'undo-left-round'],
  prompt: ['solar', 'document-text'],
  sendToCanvas: ['solar', 'gallery-send'],
  // 生产面板
  script: ['solar', 'document-text'],
  storyboard: ['solar', 'clapperboard'],
  clip: ['solar', 'video-frame'],
  character: ['solar', 'user-rounded'],
  location: ['solar', 'map-point'],
  exportPackage: ['solar', 'box'],
  quote: ['solar', 'chat-square-call'],
  compare: ['solar', 'transfer-horizontal'],
  history: ['solar', 'history'],
  collapseAll: ['solar', 'list-up'],
  moveUp: ['solar', 'arrow-up'],
  moveDown: ['solar', 'arrow-down'],
  imageUnavailable: ['solar', 'gallery-remove'],
  // 工具箱与指南
  resize: ['solar', 'maximize'],
  compress: ['solar', 'minimize-square'],
  convertFormat: ['solar', 'transfer-horizontal'],
  rotate: ['lucide', 'rotate-cw'],
  flipHorizontal: ['lucide', 'flip-horizontal-2'],
  flipVertical: ['lucide', 'flip-vertical-2'],
  collage: ['solar', 'widget'],
  stitch: ['lucide', 'gallery-vertical'],
  slice: ['lucide', 'grid-3x3'],
  sendToComposer: ['solar', 'gallery-send'],
  gettingStarted: ['lucide', 'rocket'],
  tip: ['lucide', 'lightbulb'],
  help: ['solar', 'question-circle'],
  // 画布工具
  select: ['solar', 'cursor'],
  pan: ['lucide', 'hand'],
  draw: ['solar', 'pen'],
  erase: ['solar', 'eraser'],
  drawArrow: ['solar', 'arrow-right-up'],
  text: ['lucide', 'type'],
  shape: ['lucide', 'shapes'],
  undo: ['solar', 'undo-left'],
  redo: ['solar', 'undo-right'],
  duplicate: ['solar', 'copy'],
  zoomIn: ['solar', 'magnifer-zoom-in'],
  zoomOut: ['solar', 'magnifer-zoom-out'],
  fit: ['solar', 'maximize'],
  layers: ['solar', 'layers'],
  // 媒体与文件
  image: ['solar', 'gallery'],
  images: ['solar', 'gallery-wide'],
  video: ['solar', 'videocamera'],
  play: ['solar', 'play'],
  pause: ['solar', 'pause'],
  volume: ['solar', 'volume-loud'],
  fullscreen: ['solar', 'full-screen'],
  minimize: ['solar', 'minimize'],
  download: ['solar', 'download-minimalistic'],
  upload: ['solar', 'upload-minimalistic'],
  share: ['solar', 'share'],
  link: ['solar', 'link'],
  copy: ['solar', 'copy'],
  folder: ['solar', 'folder-open'],
  database: ['solar', 'database'],
  delete: ['solar', 'trash-bin-2'],
  edit: ['solar', 'pen-2'],
  code: ['solar', 'code'],
  // Agent 交互与技能
  terminal: ['lucide', 'terminal'],
  diagnostic: ['solar', 'bug'],
  selectLasso: ['lucide', 'lasso'],
  selectRectangle: ['lucide', 'square'],
  starter: ['lucide', 'corner-down-right'],
  poster: ['solar', 'presentation-graph'],
  shop: ['solar', 'shop'],
  resolution: ['solar', 'monitor'],
  firstFrame: ['lucide', 'skip-back'],
  lastFrame: ['lucide', 'skip-forward'],
  keyframes: ['solar', 'video-frame'],
  audio: ['solar', 'soundwave'],
  aperture: ['lucide', 'aperture'],
  camera: ['solar', 'camera'],
  flame: ['solar', 'fire'],
  focus: ['lucide', 'focus'],
  home: ['solar', 'home-2'],
  imageAnimate: ['lucide', 'image-play'],
  translate: ['lucide', 'languages'],
  layoutTemplate: ['lucide', 'layout-template'],
  advertise: ['lucide', 'megaphone'],
  landscape: ['lucide', 'mountain'],
  notebook: ['lucide', 'notebook-pen'],
  productAdd: ['lucide', 'package-plus'],
  palette: ['solar', 'palette'],
  replace: ['lucide', 'replace'],
  imageInspect: ['lucide', 'scan-search'],
  product: ['solar', 'bag-4'],
  cart: ['solar', 'cart-large'],
  sprout: ['lucide', 'sprout'],
  waves: ['lucide', 'waves'],
  agentActivity: ['lucide', 'sparkle'],
  // 通用
  search: ['solar', 'magnifer'],
  add: ['solar', 'add'],
  close: ['solar', 'close'],
  check: ['solar', 'check'],
  more: ['solar', 'menu-dots'],
  filter: ['solar', 'filter'],
  sort: ['solar', 'sort'],
  grid: ['solar', 'widget'],
  list: ['solar', 'list'],
  chevronUp: ['solar', 'alt-arrow-up'],
  chevronDown: ['solar', 'alt-arrow-down'],
  chevronLeft: ['solar', 'alt-arrow-left'],
  chevronRight: ['solar', 'alt-arrow-right'],
  arrowRight: ['solar', 'arrow-right'],
  external: ['solar', 'square-top-up'],
  drag: ['solar', 'hamburger-menu'],
  // 状态
  loading: ['lucide', 'loader-circle'],
  success: ['solar', 'check-circle'],
  warning: ['solar', 'danger-triangle'],
  error: ['solar', 'danger-circle'],
  info: ['solar', 'info-circle'],
  blocked: ['solar', 'forbidden-circle'],
  lock: ['solar', 'lock'],
  unlock: ['solar', 'lock-unlocked'],
  key: ['solar', 'key'],
  visible: ['solar', 'eye'],
  hidden: ['solar', 'eye-closed'],
  notify: ['solar', 'bell'],
  credits: ['solar', 'bolt'],
  clock: ['solar', 'clock-circle'],
}

/**
 * lucide `gauge` 的指针从圆心指向右上。思考深度三档保留同一条表盘弧，
 * 只把指针改成向左 / 向上 / 向右（快速 / 中等 / 深度）。
 */
const GAUGE_NEEDLE = {
  gaugeLow: [-1, 0],
  gaugeMid: [0, -1],
  gaugeHigh: [1, 0],
}

function formatCoord(value) {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** 表盘路径原样保留，针长与 lucide 原针相同。 */
function gaugeWithNeedle(body, [dx, dy]) {
  const normalized = body.replace(/stroke-width="[\d.]+"/g, 'stroke-width="1.5"')
  return normalized.replace(/d="([^"]+)"/, (_, d) => {
    const match = /^m(-?[\d.]+) (-?[\d.]+)l(-?[\d.]+)(-?[\d.]+)(.*)$/.exec(d)
    if (!match) throw new Error(`unexpected gauge path: ${d}`)
    const [, x, y, ndx, ndy, rest] = match
    const length = Math.hypot(Number(ndx), Number(ndy))
    const nx = formatCoord(dx * length)
    const ny = formatCoord(dy * length)
    const needle = ny.startsWith('-') ? `l${nx}${ny}` : `l${nx} ${ny}`
    return `d="m${x} ${y}${needle}${rest}"`
  })
}

async function fetchSet(prefix, names) {
  const url = `https://api.iconify.design/${prefix}.json?icons=${[...new Set(names)].join(',')}`
  const response = await fetch(url, { headers: { 'User-Agent': 'muvloom-icon-build/1.0' } })
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  const data = await response.json()
  const lookup = (name) =>
    data.icons[name]?.body ?? (data.aliases?.[name] ? lookup(data.aliases[name].parent) : null)
  return lookup
}

const solarNames = Object.values(GLYPHS)
  .filter(([source]) => source === 'solar')
  .flatMap(([, name]) => [`${name}-linear`, `${name}-bold-duotone`])
const lucideNames = [
  ...Object.values(GLYPHS)
    .filter(([source]) => source === 'lucide')
    .map(([, name]) => name),
  'gauge',
]
const [solar, lucide] = await Promise.all([
  fetchSet('solar', solarNames),
  fetchSet('lucide', lucideNames),
])

const out = {}
const missing = []
for (const [id, [source, name]] of Object.entries(GLYPHS)) {
  if (source === 'solar') {
    const line = solar(`${name}-linear`)
    const solid = solar(`${name}-bold-duotone`)
    if (!line || !solid) missing.push(`${id} (${name})`)
    out[id] = { line, solid }
  } else {
    const line = lucide(name)?.replace(/stroke-width="[\d.]+"/g, 'stroke-width="1.5"')
    if (!line) missing.push(`${id} (${name})`)
    out[id] = { line }
  }
}
const gauge = lucide('gauge')
if (!gauge) missing.push('gauge')
else {
  for (const [id, direction] of Object.entries(GAUGE_NEEDLE)) {
    out[id] = { line: gaugeWithNeedle(gauge, direction) }
  }
}
if (missing.length) throw new Error(`missing glyphs: ${missing.join(', ')}`)

const lines = Object.entries(out).map(([id, glyph]) => `  ${id}: ${JSON.stringify(glyph)},`)
const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/components/ui/icon/glyphs.gen.ts',
)
writeFileSync(
  target,
  [
    '// 由 scripts/build-icon-glyphs.mjs 生成，不要手改。',
    '// 图形：Solar by 480 Design（CC BY 4.0），补充图形取自 lucide（ISC）。',
    '// 授权与署名见同目录 NOTICE.md。',
    'export const GLYPHS = {',
    ...lines,
    '} as const satisfies Record<string, { line: string; solid?: string }>',
    '',
  ].join('\n'),
)
console.log(`wrote ${Object.keys(out).length} glyphs → ${target}`)
