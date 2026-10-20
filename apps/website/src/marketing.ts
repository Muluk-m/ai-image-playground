import type { Locale } from './catalog'

export const ASSET = '/website-assets/v41'
export const MARK = '/brand/muvloom-mark.svg'

/** 首屏图片墙。文件名以 r26 / i25 / awesome / gpt-image 开头的条目在灵感库清单里。 */
export const WALL = [
  'r26-01.webp',
  'r26-02.webp',
  'g-abstract-liquid.webp',
  'awesome-346.webp',
  'r26-03.webp',
  'g-anime-city.webp',
  'r26-04.webp',
  'r26-06.webp',
  'g-anime-spirit.webp',
  'awesome-390.webp',
  'r26-08.webp',
  'g-arch-brutal.webp',
  'r26-10.webp',
  'r26-11.webp',
  'g-arch-interior.webp',
  'gpt-image-2-dumplings-editorial-poster.webp',
  'r26-14.webp',
  'g-character-mech.webp',
  'r26-15.webp',
  'r26-17.webp',
  'g-cine-desert.webp',
  'gpt-image-2-travel-journal-edit.webp',
  'r26-18.webp',
  'g-cine-ocean.webp',
  'r26-22.webp',
  'r26-25.webp',
  'g-cine-rain.webp',
  'i25-01.webp',
  'r26-26.webp',
  'g-fashion-neon.webp',
  'r26-28.webp',
  'r26-29.webp',
  'g-fashion-runway.webp',
  'i25-04.webp',
  'r26b-01.webp',
  'g-food-noodle.webp',
  'r26b-02.webp',
  'r26b-04.webp',
  'g-portrait-astronaut.webp',
  'i25-06.webp',
  'r26b-06.webp',
  'g-portrait-elder.webp',
  'r26b-07.webp',
  'r26b-08.webp',
  'g-product-perfume.webp',
  'i25-07.webp',
  'r26b-09.webp',
  'g-product-sneaker.webp',
  'r26b-15.webp',
  'r26b-16.webp',
  'g-product-watch.webp',
  'i25-08.webp',
  'r26b-20.webp',
  'g-surreal-whale.webp',
  'r26b-21.webp',
  'r26b-24.webp',
  'mug-1.webp',
  'i25-12.webp',
  'r26b-26.webp',
  'mug-7.webp',
  'r26b-27.webp',
  'r26b-29.webp',
  'perfume-pedestal-up.webp',
  'r26b-30.webp',
  'serum-macro.webp',
  'r26b-31.webp',
  'r26b-40.webp',
  'sneaker-turntable.webp',
  'r26b-41.webp',
  'unboxing-apparel.webp',
  'r26b-42.webp',
  'r26b-47.webp',
] as const

export function wallSrc(file: string): string {
  return `${ASSET}/wall/${file}`
}

/** 9 列循环墙，和原型同一套取图顺序，每列再接一份用来无缝滚动。 */
export function wallColumns(files: readonly string[] = WALL, columns = 9): string[][] {
  const per = Math.ceil(files.length / columns) + 3
  return Array.from({ length: columns }, (_, column) => {
    const pick = Array.from(
      { length: per },
      (_, index) => files[(column * 4 + index * columns) % files.length]!,
    )
    return pick.concat(pick)
  })
}

export function libraryFiles(files: readonly string[] = WALL): string[] {
  return files.filter((file) => /^(r26|i25|awesome|gpt-image)/.test(file))
}

/** 收尾两行，各 14 张灵感库图，再接一份做无限横移。 */
export function libraryRows(files: readonly string[] = WALL): string[][] {
  const library = libraryFiles(files)
  return [0, 1].map((row) => {
    const pick = library.slice(row * 14, row * 14 + 14)
    return pick.concat(pick)
  })
}

export interface ShowcaseCase {
  id: string | null
  key: string
  image: string
  fit?: 'cover'
  model: string
  category: string
  prompt: string
}

const PROMPTS = {
  whale:
    'Surreal photoreal image, a giant whale made of moss and flowers floating over a misty mountain valley at sunrise, small hikers watching, dreamlike, epic',
  portrait:
    '东京新宿雨夜，一位穿黑色长款风衣的年轻女性站在霓虹招牌下回头看向镜头，湿漉漉的柏油路面倒映着洋红与青色的灯光，85mm 镜头 f/1.4 浅景深，背景光斑柔和，皮肤质感真实，电影感调色，胶片颗粒细腻。街边招牌只出现虚构的日文店名，不出现任何真实品牌。',
  product:
    '一双白色与荧光绿配色的跑鞋悬浮在浅灰色无缝背景前，鞋底、中底、鞋面、鞋带等部件以爆炸图方式整齐地分层展开，柔和的棚拍光，干净的投影，工业设计渲染风格，材质细节清晰，适合电商详情页主视觉。',
  poster:
    '国潮风新春海报：朱红色背景，中央是一只用剪纸和烫金线条构成的祥龙盘绕着一轮金色满月，四周点缀祥云纹和梅花，顶部书法大字「万事顺遂」，清晰工整，配色红金为主，层次丰富，高级感节日视觉。',
} as const

export function caseHref(id: string | null): string {
  return id ? `/explore#inspirations/${encodeURIComponent(id)}` : '/explore'
}

export interface FeatureChapter {
  title: string
  body: string
  url: string
  image: string
}

export interface MarketingCopy {
  brand: string
  nav: { cases: string; features: string; inspiration: string; guide: string; start: string }
  hero: {
    line1: string
    line2: string
    body: string
    start: string
    see: string
    note: string
    scroll: string
  }
  demo: {
    eyebrow: string
    line1: string
    line2: string
    lead: string
    prompt: string
    same: string
    caption: string
  }
  cases: Array<Pick<ShowcaseCase, 'key' | 'category'>>
  featuresTitle: string
  featuresNote: string
  features: FeatureChapter[]
  gallery: {
    line1: string
    line2: string
    lead: string
    explore: string
    points: string[]
    feedAlt: string
    detailAlt: string
    feedMobileAlt: string
    detailMobileAlt: string
    detailUrl: string
  }
  end: { title: string; body: string; start: string; browse: string; note: string }
  footer: {
    tagline: string
    product: string
    help: string
    legal: string
    contact: string
    terms: string
    privacy: string
    copy: string
    domain: string
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

const FEATURE_URLS = [
  'muvloom.online/image',
  'muvloom.online/image',
  'muvloom.online/image',
  'muvloom.online/p/马克杯釉色方案',
  'muvloom.online/p/马克杯釉色方案',
  'muvloom.online/p/精华液短片',
  'muvloom.online/assets',
  'muvloom.online/explore',
] as const

const FEATURE_IMAGES = [
  'composer-capsule',
  'chat-plan',
  'chat-batch',
  'canvas',
  'edit',
  'video',
  'assets',
  'explore-v2',
] as const

const zhFeatures: Array<Pick<FeatureChapter, 'title' | 'body'>> = [
  {
    title: '一次写清所有要求',
    body: '比例、数量、画质在输入框里一栏设好，最多带 16\u00a0张参考图。',
  },
  {
    title: '让智能体替你写提示词',
    body: '说想法就行。它整理好提示词和生成计划，你确认了才开始。',
  },
  {
    title: '一次出一组，挑最好的',
    body: '结果并排对比；用 {槽位} 组合变量，一次最多 16\u00a0张。',
  },
  {
    title: '在画布上接着改',
    body: '任选一张做参考继续生成，新版本就排在原图旁边。',
  },
  {
    title: '圈哪里，改哪里',
    body: '圈出位置写上要求即可。局部重绘、擦除、抠图、扩图、裁切都在手边。',
  },
  {
    title: '让图片动起来',
    body: '文生视频或首帧生视频，5–15\u00a0秒，16:9、9:16、1:1，最高 1080p。',
  },
  {
    title: '同一个产品，张张一致',
    body: '把产品、人物、场景存成素材，生成时直接带上，或用 @ 调用。',
  },
  {
    title: '看到喜欢的，一键做同款',
    body: '每个案例都附完整提示词。悬停点「做同款」，或在详情里用作参考图。',
  },
]

const enFeatures: Array<Pick<FeatureChapter, 'title' | 'body'>> = [
  {
    title: 'Set every requirement at once',
    body: 'Ratio, count, and quality sit in one bar, with up to 16 reference images.',
  },
  {
    title: 'Let the agent write the prompt',
    body: 'Describe the idea. It drafts the prompt and the plan, and starts only after you confirm.',
  },
  {
    title: 'Generate a set, then pick the best',
    body: 'Compare results side by side. Combine {slot} variables, up to 16 images at once.',
  },
  {
    title: 'Keep editing on the canvas',
    body: 'Use any image as a reference and generate again. The new version sits beside the original.',
  },
  {
    title: 'Circle only what should change',
    body: 'Mark the area and say what you want. Inpaint, erase, cut out, expand, and crop are right there.',
  },
  {
    title: 'Put the still image in motion',
    body: 'Text-to-video or a first frame, 5–15 seconds, in 16:9, 9:16, or 1:1, up to 1080p.',
  },
  {
    title: 'Keep one product consistent',
    body: 'Save products, people, and scenes as assets. Attach them when you generate, or call them with @.',
  },
  {
    title: 'Remake anything you like',
    body: 'Every example includes the full prompt. Hover to remake it, or use it as a reference from the detail view.',
  },
]

function features(chapters: Array<Pick<FeatureChapter, 'title' | 'body'>>): FeatureChapter[] {
  return chapters.map((chapter, index) => ({
    ...chapter,
    url: FEATURE_URLS[index]!,
    image: FEATURE_IMAGES[index]!,
  }))
}

const zh: MarketingCopy = {
  brand: '幕芽',
  nav: {
    cases: '案例',
    features: '功能',
    inspiration: '灵感库',
    guide: '使用指南',
    start: '免费开始',
  },
  hero: {
    line1: '说出你要的画面',
    line2: '剩下的交给幕芽',
    body: '智能体帮你写提示词、排好生成计划，图片和视频一次出齐。不满意，就在画布上接着改。',
    start: '免费开始创作',
    see: '看看能做什么',
    note: '新用户注册即送 2000 积分',
    scroll: '向下滚动',
  },
  demo: {
    eyebrow: '真实案例',
    line1: '一句提示词',
    line2: '一张成片',
    lead: '以下都是幕芽生成的原图，配的是生成时用的提示词。看中哪张，点「做同款」直接带走。',
    prompt: '提示词',
    same: '做同款',
    caption: '幕芽生成原图',
  },
  cases: [
    { key: '超现实风光', category: '风光与场景' },
    { key: '人像', category: '人物与角色' },
    { key: '电商主图', category: '产品与电商' },
    { key: '中文海报', category: '海报与字体' },
  ],
  featuresTitle: '从想法到成片',
  featuresNote: '截图均来自幕芽当前版本。',
  features: features(zhFeatures),
  gallery: {
    line1: '不知道写什么？',
    line2: '先做同款',
    lead: '按用途整理的精选案例，每张都附完整提示词。看到喜欢的，悬停点「做同款」，或打开详情用作参考图。',
    explore: '前往探索页 →',
    points: ['按用途筛选', '原比例瀑布流', '一键做同款', '用作参考图'],
    feedAlt: '灵感探索页：按用途筛选的瀑布流',
    detailAlt: '案例详情：完整提示词、用作参考图和做同款',
    feedMobileAlt: '灵感探索页（手机）',
    detailMobileAlt: '案例详情（手机）',
    detailUrl: '案例详情',
  },
  end: {
    title: '从一句话开始',
    body: '打开浏览器就能用，登录后项目和素材自动同步。',
    start: '免费开始创作',
    browse: '浏览灵感库',
    note: '新用户注册即送 2000 积分',
  },
  footer: {
    tagline: 'AI 图片与视频创作。智能体、无限画布和主流模型，都在这里。',
    product: '产品',
    help: '帮助',
    legal: '条款',
    contact: '联系我们',
    terms: '服务条款',
    privacy: '隐私政策',
    copy: '© 2026 Muvloom 幕芽',
    domain: 'muvloom.online',
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
    start: 'Start free',
  },
  hero: {
    line1: 'Say the picture you want',
    line2: 'Muvloom handles the rest',
    body: 'The agent writes the prompt and the generation plan, then delivers images and video together. If it isn’t right, keep editing on the canvas.',
    start: 'Start creating free',
    see: 'See what it can do',
    note: 'New accounts get 2,000 credits',
    scroll: 'Scroll',
  },
  demo: {
    eyebrow: 'Real work',
    line1: 'One prompt',
    line2: 'One finished image',
    lead: 'These are original Muvloom images, shown with the prompts that made them. See one you like? Choose Make this to take it with you.',
    prompt: 'Prompt',
    same: 'Make this',
    caption: 'Original Muvloom image',
  },
  cases: [
    { key: 'Surreal landscape', category: 'Places and scenes' },
    { key: 'Portrait', category: 'People and characters' },
    { key: 'Product hero', category: 'Product and commerce' },
    { key: 'Chinese poster', category: 'Posters and type' },
  ],
  featuresTitle: 'From an idea to a finished piece',
  featuresNote: 'Screenshots are from the current version of Muvloom.',
  features: features(enFeatures),
  gallery: {
    line1: 'Not sure what to write?',
    line2: 'Start from one you like',
    lead: 'Curated examples by use, each with the full prompt. Hover to remake one, or open the detail and use it as a reference.',
    explore: 'Go to Explore →',
    points: [
      'Filter by use',
      'Original-ratio masonry',
      'Remake in one click',
      'Use as a reference',
    ],
    feedAlt: 'Explore: a masonry of examples filtered by use',
    detailAlt: 'Example detail: the full prompt, use as reference, and remake',
    feedMobileAlt: 'Explore on a phone',
    detailMobileAlt: 'Example detail on a phone',
    detailUrl: 'Example detail',
  },
  end: {
    title: 'Start with one sentence',
    body: 'Open a browser and start. Projects and assets sync after you sign in.',
    start: 'Start creating free',
    browse: 'Browse the library',
    note: 'New accounts get 2,000 credits',
  },
  footer: {
    tagline:
      'AI image and video creation. The agent, an infinite canvas, and leading models — all here.',
    product: 'Product',
    help: 'Help',
    legal: 'Legal',
    contact: 'Contact',
    terms: 'Terms',
    privacy: 'Privacy',
    copy: '© 2026 Muvloom',
    domain: 'muvloom.online',
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

const CASE_IMAGES = [
  `${ASSET}/reveal-whale.webp`,
  `${ASSET}/demo/r26-01.webp`,
  `${ASSET}/demo/r26-10.webp`,
  `${ASSET}/demo/r26-26.webp`,
] as const
const CASE_IDS = [null, 'r26-01', 'r26-10', 'r26-26'] as const
const CASE_PROMPTS = [PROMPTS.whale, PROMPTS.portrait, PROMPTS.product, PROMPTS.poster] as const

export function showcaseCases(locale: Locale): ShowcaseCase[] {
  const text = marketingCopy[locale]
  return text.cases.map((item, index) => ({
    id: CASE_IDS[index] ?? null,
    key: item.key,
    category: item.category,
    image: CASE_IMAGES[index]!,
    fit: index === 0 ? 'cover' : undefined,
    model: 'GPT Image 2.5 Flare',
    prompt: CASE_PROMPTS[index]!,
  }))
}

export const X_URL = 'https://x.com/Muluk656'
export const CONTACT_EMAIL = 'maqiqian0316@gmail.com'
