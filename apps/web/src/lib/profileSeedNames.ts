import { type AppLocale, currentLocale } from '../i18n'

/**
 * 配置档案的初值文案：按写入那一刻的界面语言取，写完就是用户的数据，不再跟着语言变。
 *
 * 它们不放进按需加载的语料：判断「这是不是一个没动过的新配置」要同时认所有语言的默认名，
 * 而英文语料在中文界面下根本没加载。`Record<AppLocale, …>` 让新增语言时漏填直接编译不过。
 */
interface ProfileSeedNames {
  newProfile: string
  defaultProfile: string
  customProvider: string
  copyOf: (name: string) => string
}

const SEED_NAMES: Record<AppLocale, ProfileSeedNames> = {
  'zh-CN': {
    newProfile: '新配置',
    defaultProfile: '默认',
    customProvider: '自定义服务商',
    copyOf: (name) => `${name}（复制）`,
  },
  en: {
    newProfile: 'New profile',
    defaultProfile: 'Default',
    customProvider: 'Custom provider',
    copyOf: (name) => `${name} (copy)`,
  },
}

export function profileSeedNames(locale: AppLocale = currentLocale()): ProfileSeedNames {
  return SEED_NAMES[locale]
}

/** 名字是不是某种界面语言下「新建配置」的默认名。用户在中文下建的空白配置，切到英文后仍然算空白。 */
export function isSeedNewProfileName(name: string): boolean {
  return Object.values(SEED_NAMES).some((names) => names.newProfile === name)
}
