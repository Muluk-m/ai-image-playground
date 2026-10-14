import { SITE_ALTERNATE_NAME, SITE_NAME, siteEntityId } from './site'

/**
 * 首页 head 里的结构化数据。只写页面上已经公开的事实：
 * 应用是网页端设计工具，站点有中英两种界面语言。不写价格、评分或 FAQ——
 * 首页没有这些可见内容，数字也会随价目变化。
 */
export function homeStructuredData(origin: string) {
  const url = `${origin}/`
  const organization = siteEntityId(origin, 'organization')
  const website = siteEntityId(origin, 'website')
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organization,
        name: SITE_NAME,
        alternateName: SITE_ALTERNATE_NAME,
        url,
        logo: {
          '@type': 'ImageObject',
          url: `${origin}/brand/apple-touch-icon.png`,
        },
      },
      {
        '@type': 'WebSite',
        '@id': website,
        name: SITE_NAME,
        alternateName: SITE_ALTERNATE_NAME,
        url,
        inLanguage: ['zh-CN', 'en'],
        publisher: { '@id': organization },
      },
      {
        '@type': 'WebApplication',
        '@id': siteEntityId(origin, 'app'),
        name: SITE_NAME,
        alternateName: SITE_ALTERNATE_NAME,
        url,
        applicationCategory: 'DesignApplication',
        operatingSystem: 'Web',
        description:
          '一句话生成图片，在无限画布上继续编辑，与 AI 智能体一起完成海报、商品图与短视频。',
        image: `${origin}/og/muvloom-og.jpg`,
        inLanguage: ['zh-CN', 'en'],
        publisher: { '@id': organization },
        isPartOf: { '@id': website },
      },
    ],
  }
}
