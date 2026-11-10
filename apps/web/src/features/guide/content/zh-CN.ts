import { type GuideContent, p } from '../model'
import { GUIDE_PATHS } from '../paths'
import { promoFilm } from './media'
import { extra } from './zh/extra'
import { composer, firstImage, modelCatalog, modes, overview, settings } from './zh/part1'
import { agent, batch, gpt26, skills, videoPage } from './zh/part2'
import {
  canvasBasics,
  canvasInpaint,
  credits,
  faqPage,
  library,
  membership,
  plugins,
  remix,
  toolbox,
} from './zh/part3'

const pages = {
  overview,
  firstImage,
  modes,
  composer,
  settings,
  modelCatalog,
  gpt26,
  batch,
  agent,
  skills,
  videoPage,
  canvasBasics,
  canvasInpaint,
  remix,
  library,
  toolbox,
  credits,
  membership,
  faqPage,
}
for (const [key, section] of Object.entries(extra)) {
  const page = pages[key as keyof typeof pages]
  if (!page) throw new Error(`guide extra has no page: ${key}`)
  page.sections.push(section)
}

const updated = '2026-11-10'

export const guideZhCN: GuideContent = {
  lang: 'zh-CN',
  root: GUIDE_PATHS['zh-CN'],
  meta: {
    title: '幕芽 Muvloom 使用指南：AI 生图、视频、画布与智能体',
    description:
      '幕芽官方使用指南：图片生成、参考图、GPT Image 2.6 动图与矢量、批量、智能体、视频、画布改图、做同款、工具箱、积分和命令行。',
    ogImageAlt: '幕芽 Muvloom 使用指南',
  },
  chrome: {
    brand: '幕芽 Muvloom',
    title: '使用指南',
    lead: '按创作页上的按钮写的操作说明。每页一件事，并附有测试环境的真实操作录像。',
    toc: '目录',
    onThisPage: '本页内容',
    prev: '上一篇',
    next: '下一篇',
    related: '相关文档',
    search: '搜索文档',
    searchEmpty: '没有找到相关内容',
    tipLabel: '提示',
    noteLabel: '说明',
    warnLabel: '注意',
    updated: '更新于',
    readingTime: '约 {n} 分钟',
    movedTitle: '页面已迁移',
    movedBody: '正在前往新页面：',
  },
  home: [
    promoFilm('幕芽站点宣传片：从一句话到出图、动图和画布改图', '说出画面，幕芽成片'),
    p(`宣传片用测试环境的真实操作剪成，字幕在画面上。下面按功能分篇，更新于 ${updated}。`),
  ],
  groups: [
    { id: 'start', title: '快速开始', pages: [overview, firstImage] },
    {
      id: 'create',
      title: '创作',
      pages: [modes, composer, settings, modelCatalog, gpt26, batch, agent, skills, videoPage],
    },
    { id: 'canvas', title: '画布', pages: [canvasBasics, canvasInpaint] },
    { id: 'explore', title: '探索', pages: [remix] },
    { id: 'assets', title: '资产', pages: [library] },
    { id: 'tools', title: '工具', pages: [toolbox] },
    { id: 'account', title: '账户', pages: [credits, membership] },
    { id: 'plugins', title: '插件', pages: [plugins] },
    { id: 'help', title: '帮助', pages: [faqPage] },
  ],
  moved: {
    '': { to: '', anchors: { faq: 'help/faq/#faq' } },
    'getting-started/': {
      to: 'start/overview/',
      anchors: { 'keep-editing': 'start/overview/#view-results', faq: 'help/faq/#faq' },
    },
    'create/': {
      to: 'create/composer/',
      anchors: {
        slots: 'create/composer/#prompts',
        'models-params': 'create/settings/#models-params',
        size: 'create/settings/#adjust-settings',
        'mask-edit': 'canvas/inpaint/#inpaint-steps',
        'saved-prompts': 'assets/library/#assets-prompts',
        'my-works': 'start/overview/#view-results',
        faq: 'help/faq/#faq',
      },
    },
    'canvas/': {
      to: 'canvas/basics/',
      anchors: { faq: 'help/faq/#faq' },
    },
    'agent/': {
      to: 'create/agent/',
      anchors: { 'agent-tips': 'create/agent/#agent-chat', faq: 'help/faq/#faq' },
    },
    'assets/': { to: 'assets/library/', anchors: { faq: 'help/faq/#faq' } },
  },
}
