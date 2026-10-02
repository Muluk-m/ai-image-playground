import { createHash } from 'node:crypto'

import { LOCALE_STORAGE_KEY } from '../i18n/storageKey'
import { BOOT_READY_EVENT, PRELOAD_RELOAD_STORAGE_KEY } from './constants'

/** A second chunk failure inside this window means reloading did not help, so stop and ask. */
const PRELOAD_RELOAD_WINDOW_MS = 60_000
/** Only consulted while React has never rendered; afterwards the app owns every loading state. */
const UNRENDERED_TIMEOUT_MS = 30_000

// Must execute independently of the module graph: a failed entry script cannot render React UI.
// Only resource failures are fatal; runtime exceptions belong to the screens React renders.
export const STARTUP_GUARD_SCRIPT = `(()=>{
  // Remove legacy cache-first workers even if the application entry cannot execute.
  try{if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).catch(()=>{});
  }}catch{}
  let rendered=false;
  let fatal=false;
  // Detached once React renders, but kept so a later chunk failure can still offer recovery.
  let splash=null;
  const boot=()=>splash||(splash=document.getElementById('boot'));
  const show=()=>{
    const element=boot();
    if(!element)return;
    if(!element.isConnected)document.body.append(element);
    element.dataset.state='error';
    document.getElementById('boot-error').hidden=false;
    let locale;try{locale=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch{}
    if((locale||navigator.language||'').startsWith('en')){
      document.getElementById('boot-error-title').textContent='Unable to open the workspace';
      document.getElementById('boot-error-description').textContent='Please reload the page to try again.';
      document.getElementById('boot-retry').textContent='Reload';
    }
  };
  const fail=()=>{fatal=true;show()};
  const onError=(event)=>{
    const target=event.target;
    if(target instanceof HTMLLinkElement&&target.relList.contains('stylesheet'))fail();
    else if(target instanceof HTMLScriptElement&&target.type==='module')fail();
  };
  const onPreloadError=(event)=>{
    let reload=false;
    try{
      const last=Number(sessionStorage.getItem(${JSON.stringify(PRELOAD_RELOAD_STORAGE_KEY)}))||0;
      if(Date.now()-last>${PRELOAD_RELOAD_WINDOW_MS}){
        sessionStorage.setItem(${JSON.stringify(PRELOAD_RELOAD_STORAGE_KEY)},String(Date.now()));
        reload=true;
      }
    }catch{}
    if(!reload){fail();return}
    event.preventDefault();
    location.reload();
  };
  const onReady=()=>{
    rendered=true;
    clearTimeout(timer);
    if(fatal)show();
    else boot()?.remove();
  };
  const timer=setTimeout(()=>{if(!rendered)show()},${UNRENDERED_TIMEOUT_MS});
  window.addEventListener('error',onError,true);
  window.addEventListener('vite:preloadError',onPreloadError);
  document.addEventListener('click',(event)=>{if(event.target instanceof Element&&event.target.closest('#boot-retry'))location.reload()});
  document.addEventListener('DOMContentLoaded',()=>{if(fatal)show()},{once:true});
  document.addEventListener(${JSON.stringify(BOOT_READY_EVENT)},onReady,{once:true});
})()`

export function startupGuardPlugin() {
  return {
    name: 'startup-guard',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        if (!html.includes('id="boot"')) return
        const guardedHtml = html.replace(
          '<head>',
          `<head><script id="startup-guard">${STARTUP_GUARD_SCRIPT}</script>`,
        )
        const identity = createHash('sha256').update(guardedHtml).digest('hex')
        return guardedHtml.replace(
          '</head>',
          `<meta name="aip-html-build" content="${identity}"></head>`,
        )
      },
    },
  }
}
