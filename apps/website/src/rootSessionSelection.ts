/** Runs in the prerendered head before marketing can paint. This selects presentation, not auth. */
export const ROOT_SESSION_SELECTION_SCRIPT = `(()=>{
  const path=location.pathname.replace(/\\/+$/,'')||'/';
  if(path!=='/'&&path!=='/en')return;
  const query=new URLSearchParams(location.search);
  let hinted=query.get('auth_session')==='1';
  try{hinted=hinted||document.cookie.split(';').some(part=>{const [name,value]=part.trim().split('=');return name==='image_playground_signed_in'&&Boolean(value)})}catch{}
  try{const raw=localStorage.getItem('image-playground.last-storage-user');if(raw){const id=JSON.parse(raw);hinted=hinted||(typeof id==='string'&&id.length>0)}}catch{}
  if(!hinted)return;
  document.documentElement.style.visibility='hidden';
  location.replace('/workbench'+location.search+location.hash);
})()`
