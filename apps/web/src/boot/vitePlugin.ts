import { createHash } from 'node:crypto'

// Must execute independently of the module graph: a failed entry script cannot render React UI.
export const STARTUP_GUARD_SCRIPT = `(()=>{
  // Remove legacy cache-first workers even if the application entry cannot execute.
  try{if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.map(registration=>registration.unregister()))).catch(()=>{});
  }}catch{}
  let stopped=false;
  let stylesheetFailed=false;
  const stop=()=>{stopped=true;clearTimeout(timer);window.removeEventListener('error',onError,true);window.removeEventListener('unhandledrejection',fail);document.removeEventListener('click',onClick);if(stylesheetFailed){document.getElementById('boot-retry').onclick=()=>location.reload()}else{document.getElementById('boot')?.remove()}};
  const fail=()=>{
    if(stopped)return;
    const boot=document.getElementById('boot');
    if(!boot)return;
    boot.dataset.state='error';
    boot.classList.remove('is-done');
    const panel=document.getElementById('boot-error');
    panel.hidden=false;
    let locale;try{locale=localStorage.getItem('aip.locale')}catch{}
    if((locale||navigator.language||'').startsWith('en')){
      document.getElementById('boot-error-title').textContent='Unable to open the workspace';
      document.getElementById('boot-error-description').textContent='Please reload the page to try again.';
      document.getElementById('boot-retry').textContent='Reload';
    }
  };
  const onError=(event)=>{
    const target=event.target;
    if(target instanceof HTMLLinkElement&&target.relList.contains('stylesheet')){stylesheetFailed=true;fail();return}
    if((target instanceof HTMLScriptElement&&target.type==='module')||event instanceof ErrorEvent)fail();
  };
  const onClick=(event)=>{if(event.target instanceof Element&&event.target.closest('#boot-retry'))location.reload()};
  const timer=setTimeout(fail,30000);
  window.addEventListener('error',onError,true);
  window.addEventListener('unhandledrejection',fail);
  document.addEventListener('click',onClick);
  document.addEventListener('app:boot-ready',stop,{once:true});
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
