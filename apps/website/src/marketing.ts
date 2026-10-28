import type { Locale } from './catalog'

export const ASSET = '/website-assets/v41'
export const MARK = '/brand/muvloom-mark.svg'

/** 官网图片都取自灵感库清单里的原图，打包在 public/website-assets/v41/wall。 */
export function wallSrc(file: string): string {
  return `${ASSET}/wall/${file}`
}

export function caseHref(id: string | null): string {
  return id ? `/explore#inspirations/${encodeURIComponent(id)}` : '/explore'
}

export type CaseGroup = 'product' | 'poster' | 'portrait' | 'illustration'
export const CASE_GROUPS: CaseGroup[] = ['product', 'poster', 'portrait', 'illustration']

export interface ShowcaseCase {
  id: string
  title: string
  group: CaseGroup
  image: string
}

export interface StarterPrompt {
  id: string
  title: string
  prompt: string
  image: string
}

export interface FeatureCard {
  title: string
  body: string
  image: string
}

export interface MarketingCopy {
  brand: string
  nav: { cases: string; features: string; inspiration: string; guide: string; signIn: string }
  hero: {
    title: string
    body: string
    placeholder: string
    mode: string
    model: string
    start: string
    note: string
  }
  cases: {
    title: string
    lead: string
    same: string
    all: string
    groups: Record<CaseGroup, string>
    titles: Record<string, string>
  }
  starters: Record<string, string>
  featuresTitle: string
  featuresNote: string
  features: Array<Omit<FeatureCard, 'image'>>
  end: { title: string; body: string; start: string }
  footer: {
    tagline: string
    product: string
    help: string
    legal: string
    contact: string
    terms: string
    privacy: string
    copy: string
  }
  contact: {
    title: string
    body: string
    close: string
    xTitle: string
    xDetail: string
    xAction: string
    mailTitle: string
    mail: string
    copy: string
    copied: string
    copyFailed: string
    send: string
  }
}

const FEATURE_IMAGES = ['chat-plan', 'chat-batch', 'canvas', 'edit', 'video', 'assets'] as const

const zh: MarketingCopy = {
  brand: '幕芽',
  nav: {
    cases: '案例',
    features: '功能',
    inspiration: '灵感库',
    guide: '使用指南',
    signIn: '登录',
  },
  hero: {
    title: '说出画面，幕芽成片',
    body: '智能体写提示词、排生成计划，图片和视频一次出齐；不满意，就在画布上接着改。',
    placeholder:
      '描述主体、场景与光影风格，例如：为青瓷马克杯做一组电商主图，白底、柔和侧光、三个角度',
    mode: '智能创作',
    model: 'GPT Image 2.5 Flare',
    start: '开始创作',
    note: '打开浏览器即可使用，登录后项目与素材自动同步。',
  },
  cases: {
    title: '真实案例',
    lead: '都是幕芽生成的原图，附完整提示词，点开即可做同款。',
    same: '做同款',
    all: '全部',
    groups: { product: '电商主图', poster: '海报', portrait: '人像', illustration: '插画' },
    titles: {
      'r26-10': '运动鞋悬浮爆炸图',
      'r26-25': '爵士音乐节海报',
      'r26-03': '金色时刻侧脸肖像',
      'r26-26': '国潮新春海报',
      'r26-11': '护肤精华 · 水晶质感',
      'r26-01': '雨夜霓虹街头人像',
      'r26-18': '森林里的小邮差',
      'r26b-31': '纸艺草莓蛋糕',
    },
  },
  starters: {
    'r26-14': '日式拉面特写',
    'r26-28': '3D 迷你城市',
    'r26b-15': '石榴 · 解剖图鉴',
    'r26-29': '3D 毛绒角色',
    'r26-15': '法式甜点下午茶',
  },
  featuresTitle: '从想法到成片',
  featuresNote: '截图均来自幕芽当前版本。',
  features: [
    { title: '智能体写提示词', body: '说想法即可，它整理提示词和生成计划，你确认后才开始。' },
    { title: '一次出一组', body: '结果并排对比，用槽位组合变量，一次最多 16\u00a0张。' },
    { title: '在画布上接着改', body: '任选一张继续生成，新版本排在原图旁边。' },
    { title: '圈哪里，改哪里', body: '局部重绘、擦除、抠图、扩图、裁剪都在手边。' },
    { title: '让图片动起来', body: '文生视频或首帧生视频，5–15\u00a0秒，最高 1080p。' },
    { title: '产品张张一致', body: '把产品、人物、场景存成素材，生成时直接带上。' },
  ],
  end: {
    title: '从一句话开始',
    body: '不用安装，打开浏览器就能用。',
    start: '进入幕芽',
  },
  footer: {
    tagline: 'AI 图片与视频创作：智能体、无限画布和主流模型。',
    product: '产品',
    help: '帮助',
    legal: '条款',
    contact: '联系我们',
    terms: '服务条款',
    privacy: '隐私政策',
    copy: '© 2026 Muvloom 幕芽',
  },
  contact: {
    title: '联系我们',
    body: '产品反馈、合作或使用问题，都可以找我们。',
    close: '关闭',
    xTitle: 'X 私信',
    xDetail: '@Muluk656',
    xAction: '打开 X',
    mailTitle: '邮件',
    mail: 'maqiqian0316@gmail.com',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败',
    send: '发邮件',
  },
}

const en: MarketingCopy = {
  brand: 'Muvloom',
  nav: {
    cases: 'Work',
    features: 'Features',
    inspiration: 'Inspiration',
    guide: 'Guide',
    signIn: 'Sign in',
  },
  hero: {
    title: 'Describe it. Muvloom makes it.',
    body: 'The agent writes the prompt and plans the run, then delivers images and video together. Keep refining on the canvas.',
    placeholder:
      'Describe the subject, scene, and lighting. For example: a set of product shots for a celadon mug, white background, soft side light, three angles',
    mode: 'Agent',
    model: 'GPT Image 2.5 Flare',
    start: 'Start creating',
    note: 'Runs in your browser. Projects and assets sync after you sign in.',
  },
  cases: {
    title: 'Real work',
    lead: 'Original Muvloom images with their full prompts. Open one to remake it.',
    same: 'Make this',
    all: 'All',
    groups: {
      product: 'Product',
      poster: 'Posters',
      portrait: 'Portraits',
      illustration: 'Illustration',
    },
    titles: {
      'r26-10': 'Exploded sneaker',
      'r26-25': 'Jazz festival poster',
      'r26-03': 'Golden-hour profile',
      'r26-26': 'Lunar New Year poster',
      'r26-11': 'Crystal serum',
      'r26-01': 'Neon rain portrait',
      'r26-18': 'Little forest courier',
      'r26b-31': 'Paper strawberry cake',
    },
  },
  starters: {
    'r26-14': 'Ramen close-up',
    'r26-28': '3D mini city',
    'r26b-15': 'Pomegranate study',
    'r26-29': '3D plush character',
    'r26-15': 'French afternoon tea',
  },
  featuresTitle: 'From an idea to a finished piece',
  featuresNote: 'Screenshots are from the current version of Muvloom.',
  features: [
    {
      title: 'The agent writes the prompt',
      body: 'Describe the idea. It drafts the prompt and plan, and starts only after you confirm.',
    },
    {
      title: 'Generate a set',
      body: 'Compare results side by side and combine slot variables, up to 16 images at once.',
    },
    {
      title: 'Keep editing on the canvas',
      body: 'Pick any image and generate again. The new version sits beside the original.',
    },
    {
      title: 'Mark it, change it',
      body: 'Inpaint, erase, cut out, expand, and crop are right there.',
    },
    {
      title: 'Put images in motion',
      body: 'Text-to-video or first-frame video, 5–15 seconds, up to 1080p.',
    },
    {
      title: 'Consistent products',
      body: 'Save products, people, and scenes as assets and attach them when you generate.',
    },
  ],
  end: {
    title: 'Start with one sentence',
    body: 'Nothing to install. Open a browser and start.',
    start: 'Open Muvloom',
  },
  footer: {
    tagline: 'AI image and video creation: the agent, an infinite canvas, and leading models.',
    product: 'Product',
    help: 'Help',
    legal: 'Legal',
    contact: 'Contact',
    terms: 'Terms',
    privacy: 'Privacy',
    copy: '© 2026 Muvloom',
  },
  contact: {
    title: 'Contact us',
    body: 'Product feedback, partnerships, or questions — reach us here.',
    close: 'Close',
    xTitle: 'Message on X',
    xDetail: '@Muluk656',
    xAction: 'Open X',
    mailTitle: 'Email',
    mail: 'maqiqian0316@gmail.com',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Couldn’t copy',
    send: 'Send email',
  },
}

export const marketingCopy: Record<Locale, MarketingCopy> = { 'zh-CN': zh, en }

const CASES: Array<{ id: string; group: CaseGroup }> = [
  { id: 'r26-10', group: 'product' },
  { id: 'r26-25', group: 'poster' },
  { id: 'r26-03', group: 'portrait' },
  { id: 'r26-26', group: 'poster' },
  { id: 'r26-11', group: 'product' },
  { id: 'r26-01', group: 'portrait' },
  { id: 'r26-18', group: 'illustration' },
  { id: 'r26b-31', group: 'illustration' },
]

export function showcaseCases(locale: Locale): ShowcaseCase[] {
  const titles = marketingCopy[locale].cases.titles
  return CASES.map((item) => ({
    ...item,
    title: titles[item.id] ?? item.id,
    image: wallSrc(`${item.id}.webp`),
  }))
}

/** 示例提示词原样取自灵感库清单，点选只填入输入框，不会提交。 */
const STARTER_PROMPTS: Record<string, string> = {
  'r26-14':
    '一碗豚骨拉面的45度特写：浓白的汤底泛着油光，上面铺着炙烤叉烧、溏心蛋切面流出橙色蛋黄、葱花、海苔和木耳丝，热气缓缓升起，深色木桌与黑色陶碗，侧逆光突出食物质感，美食杂志摄影。',
  'r26-28':
    '等距视角 3D 迷你城市模型：一块漂浮的方形地块上有彩色小楼、咖啡馆、公园、电车轨道和小小的行人，柔和的粘土质感与光滑塑料材质，明亮的马卡龙配色，柔和的环境光与软阴影，可爱精致的 C4D 渲染风格。',
  'r26b-15':
    '一颗石榴，以博物学家解剖野外珍稀标本的方式呈现：剖开、展开、固定，像博物馆藏品，却用卡拉瓦乔式的光为《国家地理》掌镜。一半保持完整，展示深红带金褐斑的粗糙果皮与顶端的萼冠；另一半剖开至核心，宝石般晶莹的红色籽粒整齐排列在淡黄色的海绵隔膜之间，切面锋利，籽粒内部透光。纯黑丝绒背景，石榴悬浮其中。写实风格，非卡通，材质真实，细节极致。',
  'r26-29':
    '一个圆滚滚的毛绒小怪兽 3D 角色，奶黄色毛发蓬松柔软，抱着一颗发光的星星，大眼睛闪着高光，站在淡紫色渐变背景前，皮克斯级别的毛发渲染，柔和的工作室布光，治愈可爱的潮玩手办质感。',
  'r26-15':
    '一块覆盆子开心果慕斯蛋糕放在复古描金瓷盘上，表面镜面淋面光可鉴人，点缀新鲜覆盆子和金箔，背景是虚化的蕾丝桌布和一杯红茶，柔和的窗边自然光，粉绿配色，法式甜品店宣传照风格。',
}

export function starterPrompts(locale: Locale): StarterPrompt[] {
  const titles = marketingCopy[locale].starters
  return Object.entries(STARTER_PROMPTS).map(([id, prompt]) => ({
    id,
    title: titles[id] ?? id,
    prompt,
    image: wallSrc(`${id}.webp`),
  }))
}

export function featureCards(locale: Locale): FeatureCard[] {
  return marketingCopy[locale].features.map((item, index) => ({
    ...item,
    image: `${ASSET}/ui/${FEATURE_IMAGES[index]}.webp`,
  }))
}

export const X_URL = 'https://x.com/Muluk656'
export const CONTACT_EMAIL = 'maqiqian0316@gmail.com'
