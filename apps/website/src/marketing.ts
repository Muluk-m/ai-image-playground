import { SUPPORT_CONTACT } from '@image-playground/shared/support-contact'
import type { Locale } from './catalog'

export const MARK = '/brand/muvloom-mark.svg'

const V41 = '/website-assets/v41'
const HOME = '/website-assets/home'

/** 首页图片：对话截图和两张杯子原图取自 v41，四张釉色是截图里的原图裁切，两张结果是测试站真实生成。 */
export const HOME_IMAGES = {
  hero: `${HOME}/hero-chat.webp`,
  glaze: [1, 2, 3, 4].map((index) => `${HOME}/glaze-${index}.webp`),
  editBefore: `${V41}/wall/mug-7.webp`,
  editAfter: `${HOME}/edit-after.webp`,
  detailRef: `${V41}/wall/mug-1.webp`,
  detailOut: `${HOME}/detail-out.webp`,
} as const

export interface Figure {
  src: string
  alt: string
  caption: string
}

export interface CaseRow {
  id: 'batch' | 'edit' | 'detail'
  title: string
  prompt: string
  /** 末尾不拆行的一小段，避免最后一行只剩一两个字。 */
  tail?: string
  figures: Figure[]
}

export interface MarketingCopy {
  brand: string
  nav: {
    cases: string
    features: string
    inspiration: string
    guide: string
    pricing: string
    signIn: string
  }
  hero: {
    /** 两行标题，按数组分行。 */
    title: [string, string]
    body: string
    start: string
    guide: string
    shotAlt: string
  }
  cases: {
    title: string
    input: string
    rows: Array<Omit<CaseRow, 'figures'> & { captions: string[]; alts: string[] }>
  }
  features: { title: string; rows: Array<[string, string]> }
  pricing: { line: string; link: string }
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
    mailTitle: string
    mail: string
    copy: string
    copied: string
    copyFailed: string
    send: string
  }
}

const zh: MarketingCopy = {
  brand: '幕芽',
  nav: {
    cases: '案例',
    features: '功能',
    inspiration: '灵感库',
    guide: '使用指南',
    pricing: '定价',
    signIn: '登录',
  },
  hero: {
    title: ['写一段中文描述，', '生成和修改图片、视频。'],
    body: '可以附上参考图，结果直接显示在对话里。',
    start: '开始使用',
    guide: '使用指南',
    shotAlt: '幕芽对话页',
  },
  cases: {
    title: '案例',
    input: '输入',
    rows: [
      {
        id: 'batch',
        title: '批量生成',
        prompt: '杯型和场景不变，釉色换成米白、赤陶、黑釉、青釉，',
        tail: '各出一张。',
        captions: ['米白釉', '赤陶釉', '黑釉', '青釉'],
        alts: ['米白釉', '赤陶釉', '黑釉', '青釉'],
      },
      {
        id: 'edit',
        title: '改图',
        prompt: '把杯子换成哑光黑釉，杯型、咖啡和桌面光影保持不变',
        captions: ['原图', '修改后 · Image 2.5 Flare'],
        alts: ['原图，赤陶釉马克杯', '修改后，哑光黑釉马克杯'],
      },
      {
        id: 'detail',
        title: '商品图',
        prompt: '用这只青釉杯拍一张杯口特写，白天自然光，木桌，',
        tail: '画面安静一点',
        captions: ['参考图', '生成结果 · Image 2.5 Flare'],
        alts: ['参考图，青釉马克杯', '生成结果，青釉杯口特写'],
      },
    ],
  },
  features: {
    title: '功能',
    rows: [
      ['批量', '一次最多 16\u00a0张'],
      ['改图', '局部重绘、擦除、抠图、扩图、裁剪'],
      ['视频', '5–15\u00a0秒，最高 1080p，可以用图片作首帧'],
      ['画布', '参考图和每一版结果放在同一张画布上'],
      ['素材', '商品、人物、场景可以存成素材，生成时引用'],
      ['使用', '网页版，不用安装，项目和素材跟账号同步'],
    ],
  },
  pricing: { line: '按积分计费', link: '查看定价' },
  footer: {
    tagline: '图片和视频创作工具',
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
    mailTitle: '邮件',
    mail: SUPPORT_CONTACT.email,
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败',
    send: '发邮件',
  },
}

const en: MarketingCopy = {
  brand: 'Muvloom',
  nav: {
    cases: 'Examples',
    features: 'Features',
    inspiration: 'Inspiration',
    guide: 'Guide',
    pricing: 'Pricing',
    signIn: 'Sign in',
  },
  hero: {
    title: ['Write a description', 'to generate and edit images and videos.'],
    body: 'You can attach reference images. Results appear right in the chat.',
    start: 'Get started',
    guide: 'Guide',
    shotAlt: 'The Muvloom chat page',
  },
  cases: {
    title: 'Examples',
    input: 'Prompt',
    rows: [
      {
        id: 'batch',
        title: 'Batch generation',
        prompt:
          'Keep the mug shape and the scene. Change the glaze to off-white, terracotta, black and celadon, one image each.',
        captions: ['Off-white glaze', 'Terracotta glaze', 'Black glaze', 'Celadon glaze'],
        alts: ['Off-white glaze', 'Terracotta glaze', 'Black glaze', 'Celadon glaze'],
      },
      {
        id: 'edit',
        title: 'Image editing',
        prompt:
          'Change the mug to a matte black glaze. Keep the shape, the coffee and the light on the table.',
        captions: ['Original', 'Edited · Image 2.5 Flare'],
        alts: ['Original, terracotta mug', 'Edited, matte black mug'],
      },
      {
        id: 'detail',
        title: 'Product shots',
        prompt:
          'Use this celadon mug for a close-up of the rim. Natural daylight, wooden table, a calm feel.',
        captions: ['Reference', 'Result · Image 2.5 Flare'],
        alts: ['Reference, celadon mug', 'Result, close-up of the celadon mug rim'],
      },
    ],
  },
  features: {
    title: 'Features',
    rows: [
      ['Batch', 'Up to 16 images at a time'],
      ['Editing', 'Inpaint, erase, cut out, expand and crop'],
      ['Video', '5–15 seconds, up to 1080p, with an image as the first frame if you like'],
      ['Canvas', 'References and every version of the result on one canvas'],
      ['Assets', 'Save products, people and scenes as assets and reference them when you generate'],
      [
        'Access',
        'Runs in the browser with nothing to install. Projects and assets sync to your account',
      ],
    ],
  },
  pricing: { line: 'Pay with credits', link: 'See pricing' },
  footer: {
    tagline: 'Image and video creation tool',
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
    mailTitle: 'Email',
    mail: SUPPORT_CONTACT.email,
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Couldn’t copy',
    send: 'Send email',
  },
}

export const marketingCopy: Record<Locale, MarketingCopy> = { 'zh-CN': zh, en }

const CASE_IMAGES: Record<CaseRow['id'], string[]> = {
  batch: HOME_IMAGES.glaze,
  edit: [HOME_IMAGES.editBefore, HOME_IMAGES.editAfter],
  detail: [HOME_IMAGES.detailRef, HOME_IMAGES.detailOut],
}

export function caseRows(locale: Locale): CaseRow[] {
  return marketingCopy[locale].cases.rows.map(({ captions, alts, ...row }) => ({
    ...row,
    figures: CASE_IMAGES[row.id].map((src, index) => ({
      src,
      alt: alts[index] ?? '',
      caption: captions[index] ?? '',
    })),
  }))
}

export const CONTACT_EMAIL = SUPPORT_CONTACT.email
