import type { CreationCatalog, CreationReference } from '../../components/creation/draft'
import type { CreationProject } from '../../components/creation/MediaGallery'
import { exampleClipUrl } from '../canvas/lib/creationExamples'

// Review-only data. The shared components receive live catalog/media data when integrated.
export const reviewCatalog: CreationCatalog = {
  agent: [
    {
      id: 'agent-auto',
      name: '自动选择',
      description: '根据创作任务选择合适的模型',
      parameters: [
        {
          id: 'strategy',
          label: '创作策略',
          options: ['自动', '先规划', '直接执行'],
          initial: '自动',
        },
      ],
    },
    {
      id: 'agent-pro',
      name: '深度创作',
      description: '复杂创意与多步骤规划',
      parameters: [
        { id: 'strategy', label: '创作策略', options: ['先规划', '直接执行'], initial: '先规划' },
      ],
    },
  ],
  image: [
    {
      id: 'gpt-image-2.5-flare',
      name: 'Image 2.5 Flare',
      description: '文字渲染与精准图像编辑',
      parameters: [
        {
          id: 'ratio',
          label: '画面比例',
          options: ['智能', '1:1', '16:9', '9:16', '4:3', '3:4'],
          initial: '智能',
        },
        { id: 'quality', label: '画质', options: ['标准', '高清'], initial: '高清' },
        { id: 'count', label: '生成数量', options: ['1 张', '2 张', '4 张'], initial: '1 张' },
      ],
    },
    {
      id: 'gemini-3.1-flash-image',
      name: 'Gemini 3.1 Flash',
      description: '快速构图与多图创作',
      parameters: [
        {
          id: 'ratio',
          label: '画面比例',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          initial: '1:1',
        },
        { id: 'resolution', label: '分辨率', options: ['1K', '2K', '4K'], initial: '2K' },
        { id: 'count', label: '生成数量', options: ['1 张', '2 张', '4 张'], initial: '1 张' },
      ],
    },
  ],
  video: [
    {
      id: 'grok-imagine-video',
      name: 'Grok Video',
      description: '文字与图片驱动的视频创作',
      parameters: [
        { id: 'ratio', label: '画面比例', options: ['16:9', '9:16', '1:1'], initial: '16:9' },
        { id: 'resolution', label: '分辨率', options: ['480p', '720p'], initial: '720p' },
        { id: 'duration', label: '时长', options: ['5 秒', '10 秒', '15 秒'], initial: '5 秒' },
      ],
    },
    {
      id: 'agnes-video-2.5-flash',
      name: 'Agnes Video 2.5',
      description: '多种参考素材与镜头运动',
      parameters: [
        { id: 'ratio', label: '画面比例', options: ['16:9', '9:16'], initial: '16:9' },
        { id: 'resolution', label: '分辨率', options: ['720p', '1080p'], initial: '720p' },
        { id: 'duration', label: '时长', options: ['5 秒', '10 秒'], initial: '5 秒' },
      ],
    },
  ],
}
export const reviewAssets: CreationReference[] = [
  { id: 'perfume', name: '香水瓶', src: '/cases/perfume-pedestal-up.webp', kind: 'image' },
  { id: 'serum', name: '精华液', src: '/cases/serum-macro.webp', kind: 'image' },
  { id: 'sneaker', name: '运动鞋', src: '/cases/sneaker-turntable.webp', kind: 'image' },
  { id: 'apparel', name: '服饰开箱', src: '/cases/unboxing-apparel.webp', kind: 'image' },
  {
    id: 'hero1',
    name: '空间草图变写实效果图',
    src: 'https://muvloom-inspiration-assets.deepclick.com/inspirations/2026-09-28/curated-gpt-image-2/room-render-after.png',
    kind: 'image',
  },
  {
    id: 'hero2',
    name: '旅行照片变手绘手账',
    src: 'https://muvloom-inspiration-assets.deepclick.com/inspirations/2026-09-28/curated-gpt-image-2/travel-journal-after.png',
    kind: 'image',
  },
  {
    id: 'hero3',
    name: '老船长 · 皮肤质感特写',
    src: 'https://cms-r2.deepclick.com/assets/i25-04-7194e975e63f.jpg?w=320&q=85',
    kind: 'image',
  },
  {
    id: 'hero4',
    name: '角色设定三视图',
    src: 'https://cms-r2.deepclick.com/assets/i25-08-7ccc34a00f1c.jpg?w=320&q=85',
    kind: 'image',
  },
  { id: 'clip', name: '香水升镜样片', src: '/cases/perfume-pedestal-up.webp', kind: 'video' },
]
export const reviewProjects: CreationProject[] = [
  {
    id: 'p1',
    name: '流光香水 · 春日广告',
    date: '12 分钟前修改',
    kind: 'video',
    cover: reviewAssets[0].src,
  },
  {
    id: 'p2',
    name: '山野精华 · 产品摄影',
    date: '今天修改',
    kind: 'image',
    cover: reviewAssets[1].src,
  },
  { id: 'p3', name: '未命名画布', date: '今天修改', kind: 'image' },
  { id: 'p4', name: '跑向清晨', date: '昨天修改', kind: 'video', cover: reviewAssets[2].src },
  { id: 'p5', name: '新一季的创作想法', date: '昨天修改', kind: 'agent' },
  {
    id: 'p6',
    name: '自然质感服饰 · 秋冬系列',
    date: '10 月 10 日修改',
    kind: 'image',
    cover: reviewAssets[3].src,
  },
  {
    id: 'p7',
    name: '暖木空间 · 光影习作',
    date: '10 月 9 日修改',
    kind: 'image',
    cover: reviewAssets[4].src,
  },
]
export const reviewVideoUrl = exampleClipUrl('perfume-pedestal-up')
