import { OAUTH_SESSION_QUERY_PARAM, USER_SESSION_HINT_COOKIE } from '@image-playground/shared'
import { LAST_USER_KEY } from '../../web/src/lib/localRecovery'

/**
 * Runs in the prerendered head before the marketing page paints. Visitors with a local sign-in hint
 * go straight to the workbench instead of flashing the homepage until SiteAuth finishes probing.
 * Hints only pick the page; the workbench still verifies the session and clears stale hints.
 */
export const ROOT_SESSION_SELECTION_SCRIPT = `(()=>{
  const path=location.pathname.replace(/\\/+$/,'')||'/';
  if(path!=='/'&&path!=='/en')return;
  let hinted=new URLSearchParams(location.search).get(${JSON.stringify(OAUTH_SESSION_QUERY_PARAM)})==='1';
  try{hinted=hinted||document.cookie.split(';').some(part=>{const [name,value]=part.trim().split('=');return name===${JSON.stringify(USER_SESSION_HINT_COOKIE)}&&Boolean(value)})}catch{}
  try{const raw=localStorage.getItem(${JSON.stringify(LAST_USER_KEY)});if(raw){const id=JSON.parse(raw);hinted=hinted||(typeof id==='string'&&id.length>0)}}catch{}
  if(!hinted)return;
  document.documentElement.style.visibility='hidden';
  location.replace('/image'+location.search+location.hash);
})()`
