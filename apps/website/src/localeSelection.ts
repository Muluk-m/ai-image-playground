import { LOCALE_STORAGE_KEY } from '../../web/src/i18n/storageKey'

/**
 * 中文首页在首帧前按浏览器语言选版本：没有存过语言偏好、首选语言是英文的访客直接换到 /en/。
 * 存过的偏好（官网语言链接或工作台里切换都会写）优先；爬虫不跳，两版各自收录。
 * 会话脚本已经在跳工作台时不再处理。
 */
export const ROOT_LOCALE_SELECTION_SCRIPT = `(()=>{
  const path=location.pathname.replace(/\\/+$/,'')||'/';
  if(path!=='/'||document.documentElement.style.visibility==='hidden')return;
  if(/bot|crawl|spider|slurp|preview|facebookexternalhit/i.test(navigator.userAgent||''))return;
  let stored=null;
  try{stored=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch{}
  let target=stored==='en'?'en':stored==='zh-CN'?'zh':null;
  if(!target){for(const tag of navigator.languages||[]){const primary=String(tag).toLowerCase().split('-')[0];if(primary==='zh'||primary==='en'){target=primary;break}}}
  if(target!=='en')return;
  document.documentElement.style.visibility='hidden';
  location.replace('/en/'+location.search+location.hash);
})()`

/** 访客点了官网的语言链接，就记下来，之后不再按浏览器语言跳。 */
export function rememberSiteLocale(locale: 'zh-CN' | 'en'): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 隐私模式写不进去时，链接本身照常跳转。
  }
}
