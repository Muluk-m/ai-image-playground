import { createHash } from 'node:crypto'
import type { IndexHtmlTransformContext } from 'vite'

import { LOCALE_STORAGE_KEY } from '../i18n/storageKey'
import {
  BOOT_READY_EVENT,
  BUILD_META_NAME,
  DEVICE_ID_STORAGE_KEY,
  PRELOAD_RELOAD_STORAGE_KEY,
  PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from './constants'

/** Allow one short asset-propagation wait after the immediate stale-HTML refresh. */
const RESOURCE_RECOVERY_TIMEOUT_MS = 20_000
const RESOURCE_PROBE_TIMEOUT_MS = 5_000
const RESOURCE_PROBE_INTERVAL_MS = 2_000
/** Only consulted while the shell or a failure screen has not painted; afterwards the app owns loading. */
const UNRENDERED_TIMEOUT_MS = 30_000
/** Last petal ends around 950ms. A fast shell waits out the unfurl instead of fading mid-bloom. */
export const SPROUT_HOLD_MS = 1_000
/** Matches `#boot[data-state="done"]`'s fade, plus a little slack when animationend does not fire. */
export const BOOT_FADE_MS = 700

// Must execute independently of the module graph: a failed entry script cannot render React UI.
// Resource failures and the startup deadline own this panel; runtime exceptions belong to React.
// The error panel also reports itself to the BFF, carrying the exceptions buffered before it:
// when it shows, the app bundle may never have run, so nothing else would report the failure.
/**
 * Same as `CLIENT_ERRORS_PATH` in @image-playground/shared. vite.config loads this file outside the
 * bundler, where the workspace package's TypeScript entry cannot be imported; a test keeps them equal.
 */
export const BOOT_REPORT_PATH = '/api/client-errors'

type BootAsset = readonly [src: string, tag: 'script' | 'stylesheet']

function createStartupGuardScript(requiredAssets: BootAsset[] = []) {
  return `(()=>{
  const requiredAssets=${JSON.stringify(requiredAssets)};
  // Remove legacy cache-first workers even if the application entry cannot execute.
  try{if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).catch(()=>{});
  }}catch{}
  let rendered=false;
  let fatal=false;
  const sproutStarted=performance.now();
  let cause=null;
  let reported=false;
  let reloading=false;
  let recovery=null;
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
      // The API origin lives in runtime config, which the page already preloads. Same 5 s cap as
      // the app's loadRuntimeConfig: a hung connection must not leave the report pending forever.
      fetch('/runtime-config.json',{cache:'no-store',signal:AbortSignal.timeout?AbortSignal.timeout(5000):undefined}).then(response=>response.json()).then(config=>{
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
    element.setAttribute('aria-busy','false');
    document.getElementById('boot-error').hidden=false;
    report();
    let locale;try{locale=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch{}
    if((locale||navigator.language||'').startsWith('en')){
      document.getElementById('boot-error-title').textContent='Unable to open the workspace';
      document.getElementById('boot-error-description').textContent='Please reload the page to try again.';
      document.getElementById('boot-retry').textContent='Reload';
    }
  };
  const stopRecovery=()=>{
    if(!recovery)return;
    clearTimeout(recovery.timer);
    clearTimeout(recovery.deadline);
    recovery.controller?.abort();
    recovery=null;
  };
  const fail=(reason,detail)=>{stopRecovery();fatal=true;if(!cause||cause.reason==='timeout')cause={reason,detail};show()};
  const resetBudget=()=>{
    try{
      sessionStorage.removeItem(${JSON.stringify(PRELOAD_RELOAD_STORAGE_KEY)});
      sessionStorage.removeItem(${JSON.stringify(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)});
    }catch{}
  };
  const refresh=()=>{
    if(reloading)return;
    stopRecovery();
    const next=new URL(location.href);
    next.searchParams.set(${JSON.stringify(RELOAD_QUERY_PARAM)},String(Date.now()));
    reloading=true;
    location.replace(next.href);
  };
  const retry=()=>{
    if(reloading)return true;
    if(fatal||navigator.onLine===false)return false;
    try{
      if(sessionStorage.getItem(${JSON.stringify(PRELOAD_RELOAD_STORAGE_KEY)})!==null)return false;
      // Without persistent storage an automatic navigation could loop forever.
      sessionStorage.setItem(${JSON.stringify(PRELOAD_RELOAD_STORAGE_KEY)},String(Date.now()));
    }catch{return false}
    refresh();
    return true;
  };
  // A release can expose new HTML before its entry assets reach this edge. The first reload
  // fixes stale HTML; a second failure gets one bounded wait for the ordinary asset URLs.
  const recoverResource=(detail,source)=>{
    if(fatal||navigator.onLine===false)return false;
    let url;
    try{
      url=new URL(source,location.href);
      if(url.origin!==location.origin||!url.pathname.startsWith('/assets/'))return false;
    }catch{return false}
    if(recovery){
      recovery.sources.set(url.href,detail.tag);
      if(detail.tag==='stylesheet')recovery.failedStyles.add(url.href);
      return true;
    }
    try{
      if(sessionStorage.getItem(${JSON.stringify(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)})!==null)return false;
      sessionStorage.setItem(${JSON.stringify(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)},String(Date.now()));
    }catch{return false}
    // The entry's error also fires when one of its static imports fails. Probe the build graph,
    // not only the entry URL, before consuming the last navigation. Dynamic imports stay lazy.
    const sources=new Map(requiredAssets.map(([src,tag])=>[new URL(src,location.href).href,tag]));
    sources.set(url.href,detail.tag);
    const state={sources,failedStyles:new Set(detail.tag==='stylesheet'?[url.href]:[]),timer:null,deadline:null,controller:null};
    recovery=state;
    clearTimeout(timer);
    const finish=(available)=>{
      if(recovery!==state)return;
      stopRecovery();
      if(available)refresh();
      else fail('resource',detail);
    };
    state.deadline=setTimeout(()=>finish(false),${RESOURCE_RECOVERY_TIMEOUT_MS});
    const probe=async()=>{
      if(recovery!==state)return;
      if(navigator.onLine===false){finish(false);return}
      const controller=new AbortController();
      state.controller=controller;
      const timeout=setTimeout(()=>controller.abort(),${RESOURCE_PROBE_TIMEOUT_MS});
      const sources=[...state.sources];
      try{
        const available=await Promise.all(sources.map(async([src,tag])=>{
          // Reload refreshes the ordinary URL's cache entry, so the next document can reuse it.
          const response=await fetch(src,{cache:'reload',signal:controller.signal});
          const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
          const validMime=tag==='script'?['text/javascript','application/javascript','text/ecmascript','application/ecmascript'].includes(mime):mime==='text/css';
          if(response.status!==200||!validMime)return false;
          return (await response.arrayBuffer()).byteLength>0;
        }));
        if(recovery!==state)return;
        if(sources.length===state.sources.size&&available.every(Boolean)){finish(true);return}
      }catch{}finally{clearTimeout(timeout);controller.abort()}
      if(recovery===state)state.timer=setTimeout(probe,${RESOURCE_PROBE_INTERVAL_MS});
    };
    state.timer=setTimeout(probe,${RESOURCE_PROBE_INTERVAL_MS});
    return true;
  };
  const onError=(event)=>{
    const target=event.target;
    let detail;
    let source;
    if(target instanceof HTMLLinkElement&&target.relList.contains('stylesheet')&&!target.hasAttribute('data-optional-style')){source=target.href;detail={tag:'stylesheet',src:clip(source,300)}}
    else if(target instanceof HTMLScriptElement&&target.type==='module'){source=target.src;detail={tag:'script',src:clip(source,300)}}
    else if(event instanceof ErrorEvent)note({type:'error',message:clip(event.message,300),stack:clip(event.error&&event.error.stack,1200),source:clip(event.filename,200)});
    if(detail){
      if(recovery){if(!recoverResource(detail,source))fail('resource',detail);return}
      if(!retry()&&!recoverResource(detail,source))fail('resource',detail);
    }
  };
  const onRejection=(event)=>{
    const reason=event.reason;
    note({type:'rejection',message:clip(reason&&reason.message,300)||clip(String(reason),300),stack:clip(reason&&reason.stack,1200)});
  };
  const onPreloadError=(event)=>{
    const message=event.payload&&event.payload.message;
    // Vite reports a failed CSS link again after its DOM error. Only join the recovery for
    // that exact captured stylesheet; unrelated JS import/evaluation errors must still fail.
    const cssPrefix='Unable to preload CSS for ';
    if(recovery&&typeof message==='string'&&message.startsWith(cssPrefix)){
      try{
        const url=new URL(message.slice(cssPrefix.length),location.href);
        if(recovery.failedStyles.has(url.href)){event.preventDefault();return}
      }catch{}
    }
    if(!retry()){fail('preload',{message:clip(message,300)});return}
    event.preventDefault();
  };
  const onReady=()=>{
    rendered=true;
    try{
      const current=new URL(location.href);
      if(current.searchParams.has(${JSON.stringify(RELOAD_QUERY_PARAM)})){
        current.searchParams.delete(${JSON.stringify(RELOAD_QUERY_PARAM)});
        history.replaceState(history.state,'',current.href);
      }
    }catch{}
    clearTimeout(timer);
    if(fatal&&cause?.reason!=='timeout'){show();return}
    // First paint may only be an auth check. The shell signals when it can actually be seen.
    // Keep spent navigation budgets across documents until an explicit user retry.
    if(recovery||reloading)return;
    fatal=false;
    const element=boot();
    if(!element)return;
    // A timeout panel is already the failure UI. A late render withdraws it at once.
    if(element.dataset.state==='error'){element.remove();return}
    const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait=reduce?0:Math.max(0,${SPROUT_HOLD_MS}-(performance.now()-sproutStarted));
    const reveal=()=>{
      if(!element.isConnected)return;
      element.dataset.state='done';
      element.setAttribute('aria-busy','false');
      let removed=false;
      const remove=()=>{if(removed)return;removed=true;element.remove()};
      // Petal animations bubble. Only the splash's own fade may dismiss it.
      element.addEventListener('animationend',(event)=>{if(event.target===element)remove()});
      setTimeout(remove,${BOOT_FADE_MS});
    };
    if(wait===0)reveal();else setTimeout(reveal,wait);
  };
  const timer=setTimeout(()=>{if(!rendered)fail('timeout')},${UNRENDERED_TIMEOUT_MS});
  window.addEventListener('error',onError,true);
  window.addEventListener('unhandledrejection',onRejection);
  window.addEventListener('vite:preloadError',onPreloadError);
  document.addEventListener('click',(event)=>{if(event.target instanceof Element&&event.target.closest('#boot-retry')){resetBudget();refresh()}});
  document.addEventListener('DOMContentLoaded',()=>{if(fatal)show()},{once:true});
  document.addEventListener(${JSON.stringify(BOOT_READY_EVENT)},onReady,{once:true});
})()`
}

export const STARTUP_GUARD_SCRIPT = createStartupGuardScript()

export function startupGuardPlugin() {
  return {
    name: 'startup-guard',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string, context?: IndexHtmlTransformContext) {
        if (!html.includes('id="boot"')) return
        const assets = new Map<string, 'script' | 'stylesheet'>()
        const visit = (fileName: string) => {
          if (assets.has(`/${fileName}`)) return
          const chunk = context?.bundle?.[fileName]
          if (!chunk || chunk.type !== 'chunk') return
          // vite.config uses base: '/'. Only walk the selected HTML entry's static graph.
          assets.set(`/${fileName}`, 'script')
          for (const css of chunk.viteMetadata?.importedCss ?? []) {
            assets.set(`/${css}`, 'stylesheet')
          }
          for (const dependency of chunk.imports) visit(dependency)
        }
        if (context?.chunk) visit(context.chunk.fileName)
        const script = createStartupGuardScript([...assets])
        const guardedHtml = html.replace(
          '<head>',
          `<head><script id="startup-guard">${script}</script>`,
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
