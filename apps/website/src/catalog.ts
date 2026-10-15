import { guideEn } from '../../web/src/features/guide/content/en'
import { guideZhCN } from '../../web/src/features/guide/content/zh-CN'

export type Locale = 'zh-CN' | 'en'
export const editions = { 'zh-CN': guideZhCN, en: guideEn }
export const copy = {
  'zh-CN': {
    brand: '幕芽 Muvloom',
    start: '开始创作',
    explore: '探索创作',
    guide: '使用指南',
    pricing: '定价',
    title: '故事，由你发生。',
    kicker: '给想象，一个世界。',
    scroll: '向下，展开想象',
    world: '你的角色。你的世界。',
    idea: '从一个念头开始',
    storyboard: '灵感，逐格展开。',
    beats: ['描绘', '出发', '遇见'],
    next: '下一幕，由你。',
    close: '关闭',
    back: '返回官网',
    character: '角色世界',
    boards: '故事分镜',
    view: '查看分镜',
    terms: '服务条款',
    privacy: '隐私政策',
    homeTitle: '幕芽 Muvloom — AI 图片、视频与画布创作平台',
    description:
      '从一个想法开始，用幕芽 Muvloom 创作图片与视频，在画布中整理参考、编辑作品，让你的角色和故事继续发生。',
    loginTitle: '登录幕芽 Muvloom',
    loginLead: '继续你的创作。',
    loading: '正在连接…',
    retry: '重试',
    unavailable: '暂时无法连接，请重试。',
    search: '搜索指南',
    empty: '没有找到相关内容',
    scenarios: '为你的下一次创作',
    image: '图片创作',
    video: '视频创作',
    canvas: '画布创作',
    imageBody: '描述画面，加入参考图，继续调整构图与细节。',
    videoBody: '从想法或已有图片出发，生成视频并继续整理创作素材。',
    canvasBody: '把参考、图片与视频放在同一张画布中，与智能体一起推进作品。',
    learn: '查看指南',
    notFound: '这一页还没有故事。',
    copyFailed: '复制失败，请选中文字后手动复制。',
    copied: '已复制',
    copy: '复制提示词',
  },
  en: {
    brand: 'Muvloom',
    start: 'Start creating',
    explore: 'Explore',
    guide: 'Guide',
    pricing: 'Pricing',
    title: 'Your story starts here.',
    kicker: 'Give imagination a world.',
    scroll: 'Scroll to imagine',
    world: 'Your characters. Your world.',
    idea: 'It starts with an idea',
    storyboard: 'Imagine the next frame.',
    beats: ['Imagine', 'Explore', 'Become'],
    next: 'Make the next scene yours.',
    close: 'Close',
    back: 'Back to home',
    character: 'Character world',
    boards: 'Storyboards',
    view: 'View storyboard',
    terms: 'Terms',
    privacy: 'Privacy',
    homeTitle: 'Muvloom — AI Image, Video and Canvas Creation',
    description:
      'Create images and videos with Muvloom. Bring references together on a canvas, refine your work, and develop your characters and stories with AI.',
    loginTitle: 'Sign in to Muvloom',
    loginLead: 'Continue creating.',
    loading: 'Connecting…',
    retry: 'Try again',
    unavailable: 'Unable to connect. Please try again.',
    search: 'Search the guide',
    empty: 'No matching results',
    scenarios: 'For your next creation',
    image: 'Image creation',
    video: 'Video creation',
    canvas: 'Canvas creation',
    imageBody: 'Describe a scene, add reference images, and refine the composition and details.',
    videoBody:
      'Start with an idea or an image, generate a video, and keep developing your material.',
    canvasBody:
      'Bring references, images and videos together on one canvas and develop your work with an AI agent.',
    learn: 'Read the guide',
    notFound: 'This page has no story yet.',
    copyFailed: 'Copy failed. Select the text and copy it manually.',
    copied: 'Copied',
    copy: 'Copy prompt',
  },
} as const
export const scenarios = ['image', 'video', 'canvas'] as const
export type Scenario = (typeof scenarios)[number]
export interface SitePage {
  path: string
  locale: Locale
  kind: 'home' | 'guide' | 'login' | 'scenario'
  chapterId?: string
  scenario?: Scenario
}
export const pageList: SitePage[] = (['zh-CN', 'en'] as const).flatMap((locale) => {
  const prefix = locale === 'en' ? '/en' : ''
  const guide = editions[locale]
  return [
    { path: `${prefix}/`, locale, kind: 'home' },
    { path: `${prefix}/login/`, locale, kind: 'login' },
    ...scenarios.map((scenario) => ({
      path: `${prefix}/create/${scenario}/`,
      locale,
      kind: 'scenario' as const,
      scenario,
    })),
    { path: guide.root, locale, kind: 'guide' },
    ...guide.chapters.map((chapter) => ({
      path: `${guide.root}${chapter.id}/`,
      locale,
      kind: 'guide' as const,
      chapterId: chapter.id,
    })),
  ]
})
export function findPage(path: string): SitePage | undefined {
  const normalized = `${path.replace(/\/+$/, '')}/`
  return pageList.find((page) => page.path === normalized)
}
export function alternatePage(page: SitePage): SitePage {
  return pageList.find(
    (other) =>
      other.locale !== page.locale &&
      other.kind === page.kind &&
      other.chapterId === page.chapterId &&
      other.scenario === page.scenario,
  )!
}
export function pageMeta(page: SitePage) {
  const text = copy[page.locale]
  if (page.kind === 'guide') {
    const guide = editions[page.locale]
    return page.chapterId ? guide.chapters.find((c) => c.id === page.chapterId)!.meta : guide.meta
  }
  if (page.kind === 'login') return { title: text.loginTitle, description: text.loginLead }
  if (page.kind === 'scenario' && page.scenario)
    return {
      title: `${text[page.scenario]} — ${text.brand}`,
      description: text[`${page.scenario}Body`],
    }
  return { title: text.homeTitle, description: text.description }
}
