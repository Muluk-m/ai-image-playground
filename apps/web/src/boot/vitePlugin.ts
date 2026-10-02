import { createHash } from 'node:crypto'

import { LOCALE_STORAGE_KEY } from '../i18n/storageKey'
import {
  BOOT_READY_EVENT,
  BUILD_META_NAME,
  DEVICE_ID_STORAGE_KEY,
  PRELOAD_RELOAD_STORAGE_KEY,
} from './constants'

/** A second chunk failure inside this window means reloading did not help, so stop and ask. */
const PRELOAD_RELOAD_WINDOW_MS = 60_000
/** Only consulted while React has never rendered; afterwards the app owns every loading state. */
const UNRENDERED_TIMEOUT_MS = 30_000

// Must execute independently of the module graph: a failed entry script cannot render React UI.
// Only resource failures are fatal; runtime exceptions belong to the screens React renders.
// The error panel also reports itself to the BFF, carrying the exceptions buffered before it:
// when it shows, the app bundle may never have run, so nothing else would report the failure.
/**
 * Same as `CLIENT_ERRORS_PATH` in @image-playground/shared. vite.config loads this file outside the
 * bundler, where the workspace package's TypeScript entry cannot be imported; a test keeps them equal.
 */
export const BOOT_REPORT_PATH = '/api/client-errors'

export const STARTUP_GUARD_SCRIPT = `(()=>{
  // Remove legacy cache-first workers even if the application entry cannot execute.
  try{if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).catch(()=>{});
  }}catch{}
  let rendered=false;
  let fatal=false;
  let cause=null;
  let reported=false;
  // Kept small: the whole report must fit the server's context limit.
  const early=[];
  const clip=(value,max)=>typeof value==='string'?value.slice(0,max):undefined;
  const note=(entry)=>{if(early.length<5)early.push(entry)};
  const report=()=>{
    if(reported)return;
    reported=true;
    try{
      let deviceId;try{deviceId=localStorage.getItem(${JSON.stringify(DEVICE_ID_STORAGE_KEY)})||undefined}catch{}
      const build=document.querySelector('meta[name=${JSON.stringify(BUILD_META_NAME)}]');
      const failure=cause||{reason:'timeout'};
      const body=JSON.stringify({deviceId,errors:[{
        kind:'boot',name:'BootFailure',message:failure.reason,
        url:clip(location.origin+location.pathname+location.hash,1000),
        release:build?build.content.slice(0,12):undefined,
        context:{detail:failure.detail,rendered,elapsedMs:Math.round(performance.now()),online:navigator.onLine,errors:early},
      }]});
      // The API origin lives in runtime config, which the page already preloads.
      fetch('/runtime-config.json',{cache:'no-store'}).then(response=>response.json()).then(config=>{
        const bff=config&&config.bff;
        if(!bff||!bff.enabled)return;
        const base=String((bff.baseUrlsByOrigin&&bff.baseUrlsByOrigin[location.origin])||bff.baseUrl||'').replace(/\\/+$/,'');
        const url=base+${JSON.stringify(BOOT_REPORT_PATH)};
        if(navigator.sendBeacon&&navigator.sendBeacon(url,new Blob([body],{type:'text/plain'})))return;
        return fetch(url,{method:'POST',body,keepalive:true,credentials:'include',headers:{'content-type':'text/plain'}});
      }).catch(()=>{});
    }catch{}
  };
  // Detached once React renders, but kept so a later chunk failure can still offer recovery.
  let splash=null;
  const boot=()=>splash||(splash=document.getElementById('boot'));
  const show=()=>{
    const element=boot();
    if(!element)return;
    if(!element.isConnected)document.body.append(element);
    element.dataset.state='error';
    document.getElementById('boot-error').hidden=false;
    report();
    let locale;try{locale=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch{}
    if((locale||navigator.language||'').startsWith('en')){
      document.getElementById('boot-error-title').textContent='Unable to open the workspace';
      document.getElementById('boot-error-description').textContent='Please reload the page to try again.';
      document.getElementById('boot-retry').textContent='Reload';
    }
  };
  const fail=(reason,detail)=>{fatal=true;cause=cause||{reason,detail};show()};
  const onError=(event)=>{
    const target=event.target;
    if(target instanceof HTMLLinkElement&&target.relList.contains('stylesheet'))fail('resource',{tag:'stylesheet',src:clip(target.href,300)});
    else if(target instanceof HTMLScriptElement&&target.type==='module')fail('resource',{tag:'script',src:clip(target.src,300)});
    else if(event instanceof ErrorEvent)note({type:'error',message:clip(event.message,300),stack:clip(event.error&&event.error.stack,1200),source:clip(event.filename,200)});
  };
  const onRejection=(event)=>{
    const reason=event.reason;
    note({type:'rejection',message:clip(reason&&reason.message,300)||clip(String(reason),300),stack:clip(reason&&reason.stack,1200)});
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
    if(!reload){fail('preload',{message:clip(event.payload&&event.payload.message,300)});return}
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
  window.addEventListener('unhandledrejection',onRejection);
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
          `<meta name="${BUILD_META_NAME}" content="${identity}"></head>`,
        )
      },
    },
  }
}
