/* VF Mail workspace — Gmail-parity Wave 1 client */
'use strict';
const CORE='urn:ietf:params:jmap:core',MAIL='urn:ietf:params:jmap:mail',SUB='urn:ietf:params:jmap:submission',VAC='urn:ietf:params:jmap:vacationresponse';
const PAGE=50;
const LIST_PROPS=['id','threadId','mailboxIds','keywords','from','to','subject','receivedAt','preview','hasAttachment','size'];
const IS_TAURI=!!(window.__TAURI_INTERNALS__||(window.__TAURI__&&window.__TAURI__.core)||/^tauri:$/.test(location.protocol)||location.hostname==='tauri.localhost');
const IS_ON_INBOX=/(^|\.)vfempire\.com$/i.test(location.hostname);
const JMAP_ORIGIN=IS_ON_INBOX?'':'https://inbox.vfempire.com';
const jmapUrl=path=>JMAP_ORIGIN+path;
window.__VFM_DBG__=(m)=>{try{const e=document.getElementById('li-err');if(e){e.style.color='#333';e.textContent=String(m).slice(0,240)}}catch(_){}};
window.addEventListener('DOMContentLoaded',()=>{
  window.__VFM_DBG__('boot · tauri='+IS_TAURI+' · inbox='+IS_ON_INBOX+' · origin='+location.origin);
  const u=document.getElementById('li-user'),p=document.getElementById('li-pass');
  if(u){u.addEventListener('focus',()=>window.__VFM_DBG__('address FOCUS'));u.addEventListener('input',()=>window.__VFM_DBG__('address typing → '+u.value.length+' chars'))}
  if(p){p.addEventListener('focus',()=>window.__VFM_DBG__('password FOCUS'));p.addEventListener('input',()=>window.__VFM_DBG__('password typing → '+p.value.length+' chars'))}
  const b=document.getElementById('li-btn');if(b)b.addEventListener('click',()=>window.__VFM_DBG__('Sign in clicked · user='+(u&&u.value.length)+' pass='+(p&&p.value.length)));
});
const $=id=>document.getElementById(id);
const esc=s=>(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const HUES=[212,152,262,18,338,95,45,190];
const hueFor=s=>{let h=0;for(const c of s||'')h=(h*31+c.charCodeAt(0))>>>0;return HUES[h%HUES.length]};

const S={token:sessionStorage.getItem('vfm_token')||null,user:sessionStorage.getItem('vfm_user')||'',
  acct:null,identity:null,
  boxes:{},byRole:{},labels:[],
  view:{type:'role',key:'inbox',q:''},
  list:[],threadEmails:{},emailCache:{},total:0,pos:0,
  openThreadId:null,sel:new Set(),cursor:-1,
  es:null,pollTimer:null,chordKey:null,chordAt:0,
  draftId:null,cpAtts:[],cpRefs:null,autosaveTimer:null,cpDirty:false,
  pendingSend:null,snippets:{},addrs:new Set(),lastInboxIds:null,
  filesSel:new Set(),filesFocus:null,filesClipboard:null,filesUndo:[],filesRenaming:null,
  filesHistory:[''],filesHistoryPos:0};

const SET=Object.assign({
  sig:'',sigOn:false,sigOnReply:false,notif:false,undo:10,images:'ask',imgAllow:{},
  railMin:false,railW:238,
  displayName:'',pronouns:'',pronounsCustom:'',statusKind:'none',statusText:'',
  photo:'',tz:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',
  theme:'light',accent:'#1f6ff2',density:'default',
  bgKind:'none',bgValue:'',bgBlur:'light',bgDim:15,
  pageSize:50,conv:true,defaultReply:'reply',sendArchive:false,hoverActions:true,
  keyboardOn:true,btnLabels:'icons',stars:'one',plIndicators:false,snippets:true,
  inboxType:'default',readingPane:'off',importanceMarks:true,
  offlineOn:false,offlineDays:30,autoAdvance:'newer',
  filters:[],filtersLastRun:0,blocked:[],forwardTo:'',forwardOn:false,forwardKeep:'keep',
  signatures:[],sigPrimaryNew:'',sigPrimaryReply:'',
  textStyle:{font:'',size:14,color:''},
  templates:[],
  aliases:[],replyFromSame:true,defaultIdentityId:'',
  mib:[],inboxType:'default',
  starredFiles:{},fileCollections:[],fileMeta:{},
  folders:[],fileFolders:{},currentFolder:'',
  filesBin:{},foldersBin:{},
  filesView:'grid',filesFilter:'all',filesSort:'date-desc',filesActive:'',
  filesIconSize:'md',filesHideExt:false,filesGroupBy:'none',filesShowDetails:false,
  identities:[],lastTab:'general'},
  JSON.parse(localStorage.getItem('vfmail.settings')||'{}'));
const saveSettings=()=>localStorage.setItem('vfmail.settings',JSON.stringify(SET));

/* migrate old SET.sig → SET.signatures[0] */
(function migrateSet(){
  if(!SET.signatures)SET.signatures=[];
  if(SET.sig&&!SET.signatures.length){
    const id='s'+Date.now();
    SET.signatures.push({id,name:'Primary',html:SET.sig});
    if(SET.sigOn&&!SET.sigPrimaryNew)SET.sigPrimaryNew=id;
    if(SET.sigOnReply&&!SET.sigPrimaryReply)SET.sigPrimaryReply=id;
    saveSettings();
  }
})();
const uid=p=>(p||'x')+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const sigById=id=>SET.signatures.find(s=>s.id===id);
const templateById=id=>SET.templates.find(t=>t.id===id);
const filterById=id=>SET.filters.find(f=>f.id===id);

/* ---------- JMAP ---------- */
async function jmap(calls,caps){
  const r=await fetch(jmapUrl('/jmap/'),{method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Basic '+S.token},
    body:JSON.stringify({using:[CORE,MAIL,SUB].concat(caps||[]),methodCalls:calls})});
  if(!r.ok)throw new Error('JMAP HTTP '+r.status);
  const j=await r.json();
  for(const m of j.methodResponses)if(m[0]==='error')throw new Error(m[1].type||'JMAP error');
  return j.methodResponses;
}
const resp=(rs,name)=>{const m=rs.find(x=>x[0]===name);return m?m[1]:null};
const downloadUrl=(blobId,name)=>jmapUrl(`/jmap/download/${S.acct}/${blobId}/${encodeURIComponent(name||'file')}?access_token=${encodeURIComponent(atob(S.token))}`);

/* ---------- toast + menu ---------- */
let toastTimer=null;
function toast(msg,actLabel,actFn,ms){
  const t=$('toast'),b=$('toast-act');
  $('toast-msg').textContent=msg;
  if(actLabel){b.textContent=actLabel;b.classList.remove('hidden');
    b.onclick=()=>{hideToast();actFn&&actFn()};}
  else{b.classList.add('hidden');b.onclick=null}
  t.classList.remove('hidden');
  clearTimeout(toastTimer);toastTimer=setTimeout(hideToast,ms||(actLabel?8000:3500));
}
function hideToast(){$('toast').classList.add('hidden')}
const err=e=>{console.error(e);toast(String(e.message||e))};

let menuAnchorEl=null;
function menuOpen(){return !$('menu').classList.contains('hidden')}
function showMenu(anchor,items){
  if(menuOpen()&&menuAnchorEl===anchor){hideMenu();return}
  const m=$('menu');m.innerHTML='';menuAnchorEl=anchor;
  for(const it of items){
    if(it==='—'){const d=document.createElement('div');d.className='menu-div';m.appendChild(d);continue}
    const b=document.createElement('button');b.className='menu-item';
    b.innerHTML=(it.check!==undefined?`<span class="mi-check">${it.check?'✓':''}</span>`:'')+
      (it.hue!==undefined?`<span class="mi-dot" style="background:hsl(${it.hue} 62% 52%)"></span>`:'')+
      `<span class="mi-label" style="${it.indent?'padding-left:'+it.indent*14+'px':''}">${esc(it.label)}</span>`;
    b.onclick=e=>{e.stopPropagation();if(!it.keepOpen)hideMenu();it.onclick&&it.onclick()};
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const r=anchor.getBoundingClientRect();
  m.style.left=Math.min(r.left,innerWidth-m.offsetWidth-12)+'px';
  m.style.top=Math.min(r.bottom+6,innerHeight-m.offsetHeight-12)+'px';
}
function hideMenu(){$('menu').classList.add('hidden');menuAnchorEl=null}
/* capture-phase so stopPropagation in feature handlers can't wedge the menu open;
   clicks on the anchor fall through to its own toggle */
document.addEventListener('click',e=>{
  if(!menuOpen())return;
  if($('menu').contains(e.target))return;
  if(menuAnchorEl&&menuAnchorEl.contains(e.target))return;
  hideMenu();
},true);
window.addEventListener('blur',hideMenu); /* click landed inside a message iframe */

/* ---------- login / boot ---------- */
async function login(user,pass){
  const tok=btoa(user+':'+pass);
  const url=jmapUrl('/jmap/session');
  console.log('[VFM] login →',url,'IS_TAURI=',IS_TAURI,'IS_ON_INBOX=',IS_ON_INBOX,'origin=',location.origin);
  let r;
  try{r=await fetch(url,{headers:{Authorization:'Basic '+tok},mode:'cors',credentials:'omit'})}
  catch(e){console.error('[VFM] fetch failed',e);throw new Error('Network error reaching '+url+' — '+e.message)}
  console.log('[VFM] session status',r.status,'content-type',r.headers.get('content-type'));
  if(!r.ok){const text=await r.text().catch(()=>'');console.error('[VFM] non-ok body',text.slice(0,400));throw new Error(r.status===401?'Wrong address or password.':'Server error '+r.status+' — '+text.slice(0,120))}
  let ses;try{ses=await r.json()}catch(e){const t=await r.text().catch(()=>'');console.error('[VFM] JSON parse fail',t.slice(0,400));throw new Error('Server did not return JSON. First bytes: '+t.slice(0,80))}
  console.log('[VFM] session ok',Object.keys(ses));
  S.token=tok;S.user=user;S.acct=ses.primaryAccounts[MAIL];
  sessionStorage.setItem('vfm_token',tok);sessionStorage.setItem('vfm_user',user);
  $('account-avatar').textContent=(user[0]||'v').toUpperCase();
  await boot();
  $('login').classList.add('hidden');$('app').classList.remove('hidden');
}
async function resume(){
  const r=await fetch(jmapUrl('/jmap/session'),{headers:{Authorization:'Basic '+S.token}});
  if(!r.ok)throw new Error('expired');
  const ses=await r.json();S.acct=ses.primaryAccounts[MAIL];
  $('account-avatar').textContent=(S.user[0]||'v').toUpperCase();
  await boot();
  $('login').classList.add('hidden');$('app').classList.remove('hidden');
}
async function boot(){
  const rs=await jmap([
    ['Mailbox/get',{accountId:S.acct,ids:null},'m'],
    ['Identity/get',{accountId:S.acct,ids:null},'i']]);
  indexBoxes(resp(rs,'Mailbox/get').list);
  const ids=resp(rs,'Identity/get');S.identity=(ids.list||[])[0]||null;
  await ensureSystemBoxes();
  applyRailState();
  applyAllVisualSettings();
  updateAccountAvatar();
  renderRail();fillSettingsForm();
  hydrateInboxFromCache();
  await loadList(true);
  startLive();
  armDotRails();
  armAiPanel();
  armFilesUi();
  wakeDue().catch(()=>{});
  setInterval(()=>wakeDue().catch(()=>{}),30000);
}
async function ensureSystemBoxes(){
  const create={};
  if(!S.byRole.archive)create.a={name:'Archive',role:'archive'};
  for(const n of SPECIAL_BOXES)if(!S.byName[n])create[n]={name:n};
  if(!Object.keys(create).length)return;
  await jmap([['Mailbox/set',{accountId:S.acct,create},'0']]).catch(()=>{});
  const rs=await jmap([['Mailbox/get',{accountId:S.acct,ids:null},'0']]);
  indexBoxes(resp(rs,'Mailbox/get').list);
}
const SPECIAL_BOXES=['Snoozed','Scheduled','Outbox'];
function indexBoxes(list){
  S.boxes={};S.byRole={};S.byName={};S.labels=[];
  for(const b of list){S.boxes[b.id]=b;if(b.role)S.byRole[b.role]=b;if(!S.byName[b.name])S.byName[b.name]=b}
  S.labels=list.filter(b=>!b.role&&!(SPECIAL_BOXES.includes(b.name)&&!b.parentId))
    .sort((a,b)=>labelPath(a).localeCompare(labelPath(b)));
}
function labelPath(b){
  const parts=[b.name];let p=b.parentId&&S.boxes[b.parentId],g=0;
  while(p&&g++<10){parts.unshift(p.name);p=p.parentId&&S.boxes[p.parentId]}
  return parts.join('/');
}
function labelDepth(b){let d=0,p=b.parentId&&S.boxes[b.parentId],g=0;while(p&&g++<10){d++;p=p.parentId&&S.boxes[p.parentId]}return d}

/* ---------- rail ---------- */
const RAIL_DEF=[
  {key:'inbox',kind:'role',label:'Inbox',icon:'M3 12h5l2 3h4l2-3h5M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'},
  {key:'starred',kind:'virtual',label:'Starred',icon:'M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z'},
  {key:'snoozed',kind:'named',box:'Snoozed',label:'Snoozed',icon:'M12 21a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM12 9v4l2.5 2.5M9 2h6'},
  {key:'important',kind:'virtual',label:'Important',icon:'M5 4h10l4 8-4 8H5l4-8z'},
  {key:'sent',kind:'role',label:'Sent',icon:'M21 3L10 14M21 3l-7 18-4-7-7-4z'},
  {key:'scheduled',kind:'named',box:'Scheduled',label:'Scheduled',icon:'M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 12v4M12 12l2.6 2.6'},
  {key:'outbox',kind:'named',box:'Outbox',label:'Outbox',icon:'M21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5M3 13h5l2 3h4l2-3h5M12 10V3M8.5 6.5L12 3l3.5 3.5'},
  {key:'drafts',kind:'role',label:'Drafts',icon:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'},
  {key:'allmail',kind:'virtual',label:'All mail',icon:'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5'},
  {key:'files',kind:'virtual',label:'Files',icon:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h4'},
  {key:'archive',kind:'role',label:'Archive',icon:'M3 4h18v5H3zM5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4'},
  {key:'junk',kind:'role',label:'Spam',icon:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v6M12 16.6v.4'},
  {key:'trash',kind:'role',label:'Bin',icon:'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13'}];
function railBoxFor(d){
  if(d.kind==='role')return S.byRole[d.key]||null;
  if(d.kind==='named')return S.byName[d.box]||null;
  return null;
}
function renderRail(){
  const el=$('rail-list');el.innerHTML='';
  for(const d of RAIL_DEF){
    const box=railBoxFor(d);
    if(d.kind!=='virtual'&&!box)continue;
    const n=d.key==='inbox'?(box.unreadThreads||box.unreadEmails||0):
      (d.key==='drafts'||d.kind==='named'?(box?box.totalEmails||0:0):0);
    el.appendChild(railRow('role',d.key,d.label,d.icon,n,null));
  }
  if(S.labels.length){
    const hd=document.createElement('div');hd.className='rail-sep';hd.textContent='Labels';el.appendChild(hd);
    for(const b of S.labels){
      const r=railRow('label',b.id,b.name,null,b.unreadEmails||0,hueFor(labelPath(b)));
      const depth=labelDepth(b);
      if(depth)r.style.paddingLeft=(14+depth*16)+'px';
      el.appendChild(r);
    }
  }
  markRailActive();
}
function railRow(type,key,label,icon,count,hue){
  const b=document.createElement('button');b.className='rail-row';b.dataset.type=type;b.dataset.key=key;b.title=label;
  b.innerHTML=(icon?`<svg viewBox="0 0 24 24"><path d="${icon}"/></svg>`:
    `<span class="rail-dot" style="background:hsl(${hue} 62% 52%)"></span>`)+
    `<span class="rail-name">${esc(label)}</span>`+(count?`<span class="rail-count">${count}</span>`:'');
  b.onclick=()=>{setView(type,key);$('rail').classList.remove('open')};
  if(type==='label')b.oncontextmenu=e=>{e.preventDefault();labelRailMenu(b,key)};
  return b;
}
function labelRailMenu(anchor,id){
  showMenu(anchor,[
    {label:'Rename',onclick:async()=>{const n=prompt('Rename label',S.boxes[id].name);if(!n)return;
      await jmap([['Mailbox/set',{accountId:S.acct,update:{[id]:{name:n}}},'0']]);await refreshBoxes()}},
    {label:'New sub-label',onclick:async()=>{const n=prompt('Sub-label name');if(!n)return;
      await jmap([['Mailbox/set',{accountId:S.acct,create:{l:{name:n,parentId:id}}},'0']]).catch(err);
      await refreshBoxes();toast('Sub-label created')}},
    {label:'Delete label',onclick:async()=>{
      if(S.labels.some(b=>b.parentId===id))return toast('Delete or move its sub-labels first.');
      if(!confirm('Delete label "'+S.boxes[id].name+'"? Mail keeps its other labels.'))return;
      const rs=await jmap([
        ['Email/query',{accountId:S.acct,filter:{inMailbox:id},limit:500},'q'],
        ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:['id','mailboxIds']},'e']]);
      const inLabel=resp(rs,'Email/get').list||[];
      if(inLabel.length){
        const update={};
        for(const e of inLabel){
          const patch={['mailboxIds/'+id]:null};
          if(Object.keys(e.mailboxIds||{}).length<=1&&S.byRole.archive)
            patch['mailboxIds/'+S.byRole.archive.id]=true;
          update[e.id]=patch;
        }
        await jmap([['Email/set',{accountId:S.acct,update},'0']]);
      }
      await jmap([['Mailbox/set',{accountId:S.acct,destroy:[id]},'0']]);
      if(S.view.key===id)S.view={type:'role',key:'inbox'};
      await refreshBoxes();await loadList(true);toast('Label deleted')}}]);
}
async function refreshBoxes(){
  const rs=await jmap([['Mailbox/get',{accountId:S.acct,ids:null},'0']]);
  indexBoxes(resp(rs,'Mailbox/get').list);renderRail();
}
function markRailActive(){
  document.querySelectorAll('.rail-row').forEach(b=>
    b.classList.toggle('active',b.dataset.type===S.view.type&&b.dataset.key===S.view.key));
}
function setView(type,key,q){
  S.view={type,key,q:q||''};S.sel.clear();S.cursor=-1;S.openThreadId=null;
  markRailActive();
  if(type==='role'&&key==='files'){showFiles();return}
  hideFiles();showList();loadList(true).catch(err);
}

/* ---------- search query → JMAP filter ---------- */
function parseQuery(q){
  const conds=[],nots=[],freetext=[];let m;
  const re=/(-?)(from|to|cc|subject|label|in|is|has|before|after|larger|smaller):("([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  while((m=re.exec(q))){
    if(m[2]){const neg=m[1]==='-',op=m[2].toLowerCase(),val=(m[4]!==undefined?m[4]:m[5])||'';
      const c=opCond(op,val);if(c)(neg?nots:conds).push(c);}
    else if(m[6]!==undefined)freetext.push(m[6]);
    else if(m[7])freetext.push(m[7]);
  }
  if(freetext.length)conds.push({text:freetext.join(' ')});
  const and=conds.length>1?{operator:'AND',conditions:conds}:(conds[0]||null);
  let filter=and;
  if(nots.length){
    const not={operator:'NOT',conditions:nots};
    filter=and?{operator:'AND',conditions:[and,not]}:not;
  }
  return filter||{text:q};
}
function opCond(op,val){
  switch(op){
    case 'from':return{from:val};
    case 'to':return{to:val};
    case 'cc':return{cc:val};
    case 'subject':return{subject:val};
    case 'label':case 'in':{
      const k=val.toLowerCase();
      if(k==='anywhere'||k==='all')return null;
      const box=S.byRole[k]||S.byRole[{spam:'junk',bin:'trash',deleted:'trash'}[k]]||
        S.labels.find(b=>labelPath(b).toLowerCase()===k||b.name.toLowerCase()===k)||
        Object.values(S.boxes).find(b=>b.name.toLowerCase()===k);
      return box?{inMailbox:box.id}:null}
    case 'is':return val==='starred'?{hasKeyword:'$flagged'}:
      val==='important'?{hasKeyword:'$important'}:
      val==='unread'?{notKeyword:'$seen'}:val==='read'?{hasKeyword:'$seen'}:null;
    case 'has':return val==='attachment'?{hasAttachment:true}:null;
    case 'before':return{before:val+'T00:00:00Z'};
    case 'after':return{after:val+'T00:00:00Z'};
    case 'larger':return{minSize:parseSize(val)};
    case 'smaller':return{maxSize:parseSize(val)};
  }return null;
}
const parseSize=v=>{const m=/^(\d+)(k|m)?b?$/i.exec(v);return m?+m[1]*(m[2]?(m[2].toLowerCase()==='m'?1048576:1024):1):0};

function queryFilter(){
  const v=S.view;
  if(v.type==='search')return parseQuery(v.q);
  if(v.type==='label')return{inMailbox:v.key};
  if(v.key==='starred')return{hasKeyword:'$flagged'};
  if(v.key==='important')return{hasKeyword:'$important'};
  if(v.key==='allmail'){
    const not=[];
    for(const r of ['junk','trash'])if(S.byRole[r])not.push({inMailbox:S.byRole[r].id});
    for(const n of SPECIAL_BOXES)if(S.byName[n])not.push({inMailbox:S.byName[n].id});
    return not.length?{operator:'NOT',conditions:not}:null;
  }
  const d=RAIL_DEF.find(x=>x.key===v.key);
  const box=d?railBoxFor(d):S.byRole[v.key];
  return box?{inMailbox:box.id}:null;
}

/* ---------- list ---------- */
async function loadList(reset){
  if(reset){S.pos=0;S.list=[];S.snippets={}}
  const filter=queryFilter();
  const calls=[
    ['Email/query',{accountId:S.acct,filter,sort:[{property:'receivedAt',isAscending:false}],
      collapseThreads:true,position:S.pos||0,limit:PAGE,calculateTotal:true},'q'],
    ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:LIST_PROPS},'e'],
    ['Thread/get',{accountId:S.acct,'#ids':{resultOf:'e',name:'Email/get',path:'/list/*/threadId'}},'t']];
  if(S.view.type==='search')
    calls.push(['SearchSnippet/get',{accountId:S.acct,filter,'#emailIds':{resultOf:'q',name:'Email/query',path:'/ids'}},'s']);
  const rs=await jmap(calls);
  const q=resp(rs,'Email/query'),got=resp(rs,'Email/get').list||[];
  S.total=q.total!=null?q.total:(S.pos+got.length);
  for(const th of (resp(rs,'Thread/get').list||[]))S.threadEmails[th.id]=th.emailIds;
  const sn=resp(rs,'SearchSnippet/get');
  if(sn)for(const s of sn.list||[])S.snippets[s.emailId]=s;
  got.sort((a,b)=>a.receivedAt<b.receivedAt?1:-1);
  for(const e of got){S.emailCache[e.id]=e;harvestAddrs(e)}
  S.list=reset?got:S.list.concat(got);
  renderRows();
}
function harvestAddrs(e){
  for(const p of (e.from||[]).concat(e.to||[]))if(p&&p.email&&!S.addrs.has(p.email)){
    S.addrs.add(p.email);
    const o=document.createElement('option');o.value=p.email;if(p.name)o.label=p.name;
    $('addr-list').appendChild(o);
  }
}
function viewTitle(){
  const v=S.view;
  if(v.type==='search')return'Search';
  if(v.type==='label')return S.boxes[v.key]?S.boxes[v.key].name:'Label';
  const d=RAIL_DEF.find(x=>x.key===v.key);return d?d.label:'Mail';
}
function renderRows(){
  const rows=$('rows');rows.innerHTML='';
  $('list-title').textContent=viewTitle();
  $('list-empty').classList.toggle('hidden',S.list.length>0);
  $('empty-text').textContent=S.view.type==='search'?'No results.':'Nothing here.';
  $('list-more').classList.toggle('hidden',S.list.length>=S.total);
  for(let i=0;i<S.list.length;i++)rows.appendChild(rowEl(S.list[i],i));
  updateBulkbar();updateTitle();
  if(S.view.type==='role'&&S.view.key==='inbox')cacheInbox();
  mountDotRail(rows);
}
function cacheInbox(){
  try{localStorage.setItem('vfmail.inboxCache',JSON.stringify({
    at:Date.now(),list:S.list.slice(0,50),threadEmails:S.threadEmails,
    total:S.total,byRoleInbox:S.byRole.inbox&&S.byRole.inbox.id
  }))}catch(_){}
}
function hydrateInboxFromCache(){
  try{
    const raw=localStorage.getItem('vfmail.inboxCache');if(!raw)return;
    const c=JSON.parse(raw);if(!c||!c.list)return;
    S.list=c.list;S.threadEmails=c.threadEmails||{};S.total=c.total||c.list.length;
    for(const e of c.list)S.emailCache[e.id]=e;
    renderRows();
  }catch(_){}
}
function rowEl(e,i){
  const unread=!(e.keywords&&e.keywords.$seen);
  const starred=!!(e.keywords&&e.keywords.$flagged);
  const who=(e.from&&e.from[0])?(e.from[0].name||e.from[0].email):'—';
  const cnt=(S.threadEmails[e.threadId]||[]).length;
  const snip=S.snippets[e.id];
  const preview=snip&&snip.preview?snip.preview:esc(e.preview||'');
  const subj=snip&&snip.subject?snip.subject:esc(e.subject||'(no subject)');
  const row=document.createElement('div');
  row.className='row'+(unread?' unread':'')+(S.sel.has(e.id)?' selected':'')+(S.cursor===i?' cursor':'');
  row.dataset.id=e.id;row.dataset.i=i;
  row.innerHTML=
    `<input type="checkbox" class="row-check" ${S.sel.has(e.id)?'checked':''}>`+
    `<button class="row-star${starred?' on':''}" title="Star (s)"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z"/></svg></button>`+
    `<span class="who" style="--hue:${hueFor(who)}">${esc(who)}${cnt>1?` <em>${cnt}</em>`:''}</span>`+
    `<span class="line"><b>${subj}</b><span class="prev"> — ${preview}</span></span>`+
    rowLabelChips(e)+
    (e.hasAttachment?'<svg class="clip" viewBox="0 0 24 24"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 5a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6L15 8.3"/></svg>':'')+
    `<span class="date">${fmtDate(e.receivedAt)}</span>`+
    `<span class="quick">
      <button data-a="read" title="${unread?'Mark read':'Mark unread'}"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 ${unread?'12l9 4 9-4':'8l9 6 9-6'}"/></svg></button>
      <button data-a="snooze" title="Snooze (b)"><svg viewBox="0 0 24 24"><path d="M12 21a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM12 9v4l2.5 2.5M9 2h6"/></svg></button>
      <button data-a="archive" title="Archive (e)"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg></button>
      <button data-a="trash" title="Delete (#)"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg></button>
    </span>`;
  row.querySelector('.row-check').onclick=ev=>{ev.stopPropagation();toggleSel(e.id,ev.shiftKey,i)};
  row.querySelector('.row-star').onclick=ev=>{ev.stopPropagation();toggleStar(e).catch(err)};
  row.querySelector('[data-a=snooze]').onclick=ev=>{ev.stopPropagation();snoozeMenu(ev.currentTarget,[e.threadId])};
  row.querySelector('[data-a=read]').onclick=ev=>{ev.stopPropagation();setThreadsSeen([e.threadId],unread).catch(err)};
  row.querySelector('[data-a=archive]').onclick=ev=>{ev.stopPropagation();bulkAct('archive',[e.threadId]).catch(err)};
  row.querySelector('[data-a=trash]').onclick=ev=>{ev.stopPropagation();bulkAct('trash',[e.threadId]).catch(err)};
  row.onclick=()=>{S.cursor=i;openRow(e)};
  return row;
}
function rowLabelChips(e){
  if(S.view.type==='label')return'';
  let out='';
  for(const id of Object.keys(e.mailboxIds||{})){
    const b=S.boxes[id];if(!b||b.role||(SPECIAL_BOXES.includes(b.name)&&!b.parentId))continue;
    const path=labelPath(b);
    out+=`<span class="chip" style="--hue:${hueFor(path)}">${esc(path)}</span>`;
  }
  return out?`<span class="chips">${out}</span>`:'';
}
function openRow(e){
  if(S.view.key==='scheduled'&&kwEpoch(e,'sendat_')){
    if(confirm('Cancel the scheduled send and edit as a draft?'))return cancelScheduled(e.id).catch(err);
    return openThread(e.threadId).catch(err);
  }
  if((S.view.key==='drafts'||S.view.key==='outbox')&&e.keywords&&e.keywords.$draft)resumeDraft(e.id).catch(err);
  else openThread(e.threadId).catch(err);
}

/* ---------- selection ---------- */
let lastSelIdx=-1;
function toggleSel(id,shift,idx){
  if(shift&&lastSelIdx>=0){
    const [a,b]=[Math.min(lastSelIdx,idx),Math.max(lastSelIdx,idx)];
    for(let k=a;k<=b;k++)S.sel.add(S.list[k].id);
  }else{S.sel.has(id)?S.sel.delete(id):S.sel.add(id);lastSelIdx=idx}
  renderRows();
}
function selectWhere(fn){
  S.sel.clear();
  for(const e of S.list)if(fn(e))S.sel.add(e.id);
  renderRows();
}
function updateBulkbar(){
  const n=S.sel.size;
  $('bulk-bar').classList.toggle('hidden',!n);
  $('list-title').classList.toggle('hidden',!!n);
  $('sel-master').checked=n>0&&n===S.list.length;
  $('sel-master').indeterminate=n>0&&n<S.list.length;
  $('list-meta').textContent=n?n+' selected':(S.total?`${S.list.length} of ${S.total}`:'');
}
const selThreads=()=>[...new Set([...S.sel].map(id=>(S.emailCache[id]||{}).threadId).filter(Boolean))];

/* ---------- undo engine ---------- */
async function snapshotEmails(ids){
  const rs=await jmap([['Email/get',{accountId:S.acct,ids,properties:['id','mailboxIds','keywords']},'0']]);
  const snap={};for(const e of resp(rs,'Email/get').list||[])snap[e.id]={mailboxIds:e.mailboxIds,keywords:e.keywords};
  return snap;
}
async function applyWithUndo(ids,patch,msg){
  if(!ids.length)return;
  const snap=await snapshotEmails(ids);
  const update={};for(const id of ids)update[id]=patch;
  await jmap([['Email/set',{accountId:S.acct,update},'0']]);
  toast(msg,'Undo',async()=>{
    const restore={};for(const id of Object.keys(snap))restore[id]=snap[id];
    await jmap([['Email/set',{accountId:S.acct,update:restore},'0']]).catch(err);
    await afterMutate();toast('Undone');
  });
  await afterMutate();
}
async function afterMutate(){
  await refreshBoxes().catch(()=>{});
  if(S.openThreadId&&$('thread-view').classList.contains('hidden')===false){
    /* stay in thread; list refresh happens on back */
    await loadList(true).catch(()=>{});
  }else await loadList(true).catch(()=>{});
}
const threadEmailIds=tids=>{const out=[];for(const t of tids)for(const id of (S.threadEmails[t]||[]))out.push(id);return out};

/* ---------- actions ---------- */
async function bulkAct(kind,tids){
  tids=tids||selThreads();if(!tids.length&&S.openThreadId)tids=[S.openThreadId];
  const ids=threadEmailIds(tids);if(!ids.length)return;
  const inbox=S.byRole.inbox,arch=S.byRole.archive,junk=S.byRole.junk,trash=S.byRole.trash;
  const n=tids.length,noun=n===1?'conversation':n+' conversations';
  if(kind==='archive')await applyWithUndo(ids,{['mailboxIds/'+arch.id]:true,['mailboxIds/'+inbox.id]:null},'Archived '+noun);
  if(kind==='trash')await applyWithUndo(ids,{mailboxIds:{[trash.id]:true}},'Deleted '+noun);
  if(kind==='spam')await applyWithUndo(ids,{mailboxIds:{[junk.id]:true},['keywords/$junk']:true},'Reported spam');
  if(kind==='notspam')await applyWithUndo(ids,{mailboxIds:{[inbox.id]:true},['keywords/$junk']:null,['keywords/$notjunk']:true},'Not spam — moved to Inbox');
  S.sel.clear();
  if(S.openThreadId&&tids.includes(S.openThreadId))showList();
}
async function setThreadsSeen(tids,seen){
  tids=tids||selThreads();
  const ids=threadEmailIds(tids);if(!ids.length)return;
  const update={};for(const id of ids)update[id]={['keywords/$seen']:seen?true:null};
  await jmap([['Email/set',{accountId:S.acct,update},'0']]);
  await afterMutate();
}
async function toggleStar(e){
  const on=!(e.keywords&&e.keywords.$flagged);
  await jmap([['Email/set',{accountId:S.acct,update:{[e.id]:{['keywords/$flagged']:on?true:null}}},'0']]);
  if(S.emailCache[e.id]){S.emailCache[e.id].keywords=Object.assign({},S.emailCache[e.id].keywords,{$flagged:on?true:undefined});
    if(!on)delete S.emailCache[e.id].keywords.$flagged}
  const li=S.list.find(x=>x.id===e.id);if(li)li.keywords=S.emailCache[e.id]?S.emailCache[e.id].keywords:li.keywords;
  renderRows();
}
function labelMenu(anchor,tids){
  tids=tids&&tids.length?tids:(S.openThreadId?[S.openThreadId]:selThreads());
  if(!tids.length)return;
  const ids=threadEmailIds(tids);
  const first=S.emailCache[ids[0]]||{};
  const items=S.labels.map(b=>({
    label:b.name,hue:hueFor(labelPath(b)),indent:labelDepth(b),keepOpen:true,
    check:!!(first.mailboxIds&&first.mailboxIds[b.id]),
    onclick:async()=>{
      const on=!(first.mailboxIds&&first.mailboxIds[b.id]);
      const update={};for(const id of ids)update[id]={['mailboxIds/'+b.id]:on?true:null};
      await jmap([['Email/set',{accountId:S.acct,update},'0']]).catch(err);
      hideMenu();toast(on?('Labelled "'+b.name+'"'):('Removed "'+b.name+'"'));
      await afterMutate();if(S.openThreadId)renderThreadLabels();
    }}));
  items.push('—',{label:'Create new label…',onclick:()=>newLabel(tids)});
  showMenu(anchor,items);
}
function moveMenu(anchor,tids){
  tids=tids&&tids.length?tids:(S.openThreadId?[S.openThreadId]:selThreads());
  if(!tids.length)return;
  const ids=threadEmailIds(tids);
  const dest=[['inbox','Inbox'],['archive','Archive'],['junk','Spam'],['trash','Bin']]
    .filter(([r])=>S.byRole[r]).map(([r,label])=>({label,onclick:()=>doMove(ids,S.byRole[r].id,label)}));
  const labels=S.labels.map(b=>({label:b.name,hue:hueFor(labelPath(b)),indent:labelDepth(b),onclick:()=>doMove(ids,b.id,labelPath(b))}));
  showMenu(anchor,dest.concat(labels.length?['—'].concat(labels):[]));
}
async function doMove(ids,boxId,name){
  await applyWithUndo(ids,{mailboxIds:{[boxId]:true}},'Moved to '+name);
  S.sel.clear();
  if(S.openThreadId)showList();
}
async function newLabel(tids){
  const name=prompt('New label name — use / to nest (e.g. Clients/Acme)');if(!name)return;
  const parts=name.split('/').map(s=>s.trim()).filter(Boolean);
  if(!parts.length)return;
  let parentId=null,leafId=null;
  for(const part of parts){
    const existing=S.labels.find(b=>b.name.toLowerCase()===part.toLowerCase()&&(b.parentId||null)===parentId);
    if(existing){parentId=existing.id;leafId=existing.id;continue}
    const spec={name:part};if(parentId)spec.parentId=parentId;
    const rs=await jmap([['Mailbox/set',{accountId:S.acct,create:{l:spec}},'0']]).catch(err);
    if(!rs)return;
    const made=resp(rs,'Mailbox/set').created;
    if(!(made&&made.l))return toast('Could not create label "'+part+'"');
    await refreshBoxes();
    parentId=made.l.id;leafId=made.l.id;
  }
  if(tids&&tids.length&&leafId){
    const ids=threadEmailIds(tids),update={};
    for(const id of ids)update[id]={['mailboxIds/'+leafId]:true};
    await jmap([['Email/set',{accountId:S.acct,update},'0']]).catch(err);
    await afterMutate();
  }
  toast('Label "'+parts.join('/')+'" ready');
}

/* ---------- snooze ---------- */
function kwEpoch(e,prefix){
  for(const k of Object.keys(e.keywords||{}))if(k.startsWith(prefix))return +k.slice(prefix.length)||0;
  return 0;
}
const fmtWhen=ep=>new Date(ep*1000).toLocaleString([],{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const fmtLocalInput=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
function parseLocalInput(v){
  const m=/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec((v||'').trim());
  if(!m)return 0;
  return Math.floor(new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]).getTime()/1000);
}
function snoozeTimes(){
  const now=new Date(),at=d=>Math.floor(d.getTime()/1000);
  const later=new Date(now.getTime()+4*3600e3);later.setMinutes(0,0,0);
  const tom=new Date(now);tom.setDate(now.getDate()+1);tom.setHours(8,0,0,0);
  const mon=new Date(now);mon.setDate(now.getDate()+(((8-now.getDay())%7)||7));mon.setHours(8,0,0,0);
  return{later:at(later),tom:at(tom),mon:at(mon),laterD:later,tomD:tom,monD:mon};
}
function snoozeMenu(anchor,tids){
  tids=tids&&tids.length?tids:(S.openThreadId?[S.openThreadId]:selThreads());
  if(!tids.length)return;
  const t=snoozeTimes();
  const items=[
    {label:'Later today · '+t.laterD.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),onclick:()=>doSnooze(tids,t.later)},
    {label:'Tomorrow · 08:00',onclick:()=>doSnooze(tids,t.tom)},
    {label:'Next week · Mon 08:00',onclick:()=>doSnooze(tids,t.mon)},
    '—',
    {label:'Pick date & time…',onclick:()=>{
      const v=prompt('Snooze until (YYYY-MM-DD HH:MM)',fmtLocalInput(t.tomD));if(v===null)return;
      const ep=parseLocalInput(v);if(!ep)return toast('Could not read that time.');
      if(ep*1000<Date.now()+30000)return toast('Pick a time in the future.');
      doSnooze(tids,ep)}}];
  if(S.view.key==='snoozed')items.push('—',{label:'Unsnooze — back to Inbox',onclick:()=>unsnooze(tids)});
  showMenu(anchor,items);
}
async function doSnooze(tids,epoch){
  const sn=S.byName.Snoozed,inbox=S.byRole.inbox;if(!sn||!inbox)return;
  const ids=threadEmailIds(tids);if(!ids.length)return;
  const snap=await snapshotEmails(ids);
  const update={};
  for(const id of ids){
    const patch={['mailboxIds/'+sn.id]:true,['mailboxIds/'+inbox.id]:null,['keywords/snoozed_'+epoch]:true};
    for(const k of Object.keys((snap[id]||{}).keywords||{}))
      if(k.startsWith('snoozed_')&&k!=='snoozed_'+epoch)patch['keywords/'+k]=null;
    update[id]=patch;
  }
  await jmap([['Email/set',{accountId:S.acct,update},'0']]);
  toast('Snoozed until '+fmtWhen(epoch),'Undo',async()=>{
    await jmap([['Email/set',{accountId:S.acct,update:snap}, '0']]).catch(err);
    await afterMutate();toast('Undone');
  });
  S.sel.clear();
  if(S.openThreadId&&tids.includes(S.openThreadId))showList();
  await afterMutate();
}
async function unsnooze(tids){
  const sn=S.byName.Snoozed,inbox=S.byRole.inbox;if(!sn||!inbox)return;
  const ids=threadEmailIds(tids);if(!ids.length)return;
  const snap=await snapshotEmails(ids);
  const update={};
  for(const id of ids){
    const patch={['mailboxIds/'+inbox.id]:true,['mailboxIds/'+sn.id]:null};
    for(const k of Object.keys((snap[id]||{}).keywords||{}))if(k.startsWith('snoozed_'))patch['keywords/'+k]=null;
    update[id]=patch;
  }
  await jmap([['Email/set',{accountId:S.acct,update},'0']]);
  S.sel.clear();toast('Moved back to Inbox');
  await afterMutate();
}
async function wakeDue(){
  const sn=S.byName.Snoozed,inbox=S.byRole.inbox;
  if(sn&&inbox&&sn.totalEmails!==0){
    const rs=await jmap([
      ['Email/query',{accountId:S.acct,filter:{inMailbox:sn.id},limit:200},'q'],
      ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:['id','keywords']},'e']]);
    const now=Math.floor(Date.now()/1000),update={};let n=0;
    for(const e of resp(rs,'Email/get').list||[]){
      const t=kwEpoch(e,'snoozed_');
      if(t&&t<=now){
        const patch={['mailboxIds/'+inbox.id]:true,['mailboxIds/'+sn.id]:null,['keywords/$seen']:null};
        for(const k of Object.keys(e.keywords||{}))if(k.startsWith('snoozed_'))patch['keywords/'+k]=null;
        update[e.id]=patch;n++;
      }
    }
    if(n){
      await jmap([['Email/set',{accountId:S.acct,update},'0']]);
      await refreshBoxes().catch(()=>{});
      if(!S.openThreadId)loadList(true).catch(()=>{});
    }
  }
  await dispatchDue();
}

/* ---------- schedule send ---------- */
function scheduleMenu(anchor){
  const t=snoozeTimes();
  const aft=new Date(t.tomD);aft.setHours(13,0,0,0);
  showMenu(anchor,[
    {label:'Tomorrow morning · 08:00',onclick:()=>saveScheduled(t.tom)},
    {label:'Tomorrow afternoon · 13:00',onclick:()=>saveScheduled(Math.floor(aft.getTime()/1000))},
    {label:'Monday morning · 08:00',onclick:()=>saveScheduled(t.mon)},
    '—',
    {label:'Pick date & time…',onclick:()=>{
      const v=prompt('Send at (YYYY-MM-DD HH:MM)',fmtLocalInput(t.tomD));if(v===null)return;
      const ep=parseLocalInput(v);if(!ep)return toast('Could not read that time.');
      if(ep*1000<Date.now()+60000)return toast('Pick a time in the future.');
      saveScheduled(ep)}}]);
}
async function saveScheduled(epoch){
  if(!parseAddrs($('cp-to').value).length)return toast('Add at least one recipient.');
  const sch=S.byName.Scheduled;if(!sch)return toast('No Scheduled folder on this account.');
  const obj=buildEmailObject({$draft:true,['sendat_'+epoch]:true},{[sch.id]:true});
  const oldDraft=S.draftId;
  clearInterval(S.autosaveTimer);S.autosaveTimer=null;
  $('compose').classList.add('hidden');
  S.draftId=null;S.cpAtts=[];S.cpRefs=null;S.cpDirty=false;
  const rs=await jmap([['Email/set',{accountId:S.acct,create:{d:obj},destroy:oldDraft?[oldDraft]:[]},'0']]);
  const st=resp(rs,'Email/set');
  if(!(st.created&&st.created.d))return toast('Could not schedule the send.');
  toast('Send scheduled for '+fmtWhen(epoch));
  await afterMutate();
}
async function cancelScheduled(id){
  const drafts=S.byRole.drafts,sch=S.byName.Scheduled;
  const rs=await jmap([['Email/get',{accountId:S.acct,ids:[id],properties:['id','keywords']},'0']]);
  const e=(resp(rs,'Email/get').list||[])[0];if(!e)return;
  const patch={['mailboxIds/'+drafts.id]:true};
  if(sch)patch['mailboxIds/'+sch.id]=null;
  for(const k of Object.keys(e.keywords||{}))if(k.startsWith('sendat_'))patch['keywords/'+k]=null;
  await jmap([['Email/set',{accountId:S.acct,update:{[id]:patch}},'0']]);
  toast('Scheduled send cancelled — now a draft');
  await resumeDraft(id);
  await refreshBoxes().catch(()=>{});
}
let dispatching=false;
async function dispatchDue(){
  if(dispatching)return;dispatching=true;
  try{
    const sch=S.byName.Scheduled,out=S.byName.Outbox,sent=S.byRole.sent;
    if(!sch||!S.identity||sch.totalEmails===0)return;
    const rs=await jmap([
      ['Email/query',{accountId:S.acct,filter:{inMailbox:sch.id},limit:50},'q'],
      ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:['id','keywords']},'e']]);
    const now=Math.floor(Date.now()/1000);let sentN=0;
    for(const e of resp(rs,'Email/get').list||[]){
      const t=kwEpoch(e,'sendat_');
      if(!t||t>now)continue;
      const toOut={};
      if(out){toOut['mailboxIds/'+out.id]=true;toOut['mailboxIds/'+sch.id]=null}
      const onOk={['keywords/$draft']:null,['mailboxIds/'+(sent?sent.id:sch.id)]:true,
        ['mailboxIds/'+(out?out.id:sch.id)]:null};
      for(const k of Object.keys(e.keywords||{}))if(k.startsWith('sendat_'))onOk['keywords/'+k]=null;
      const sr=await jmap([
        ['Email/set',{accountId:S.acct,update:{[e.id]:toOut}},'0'],
        ['EmailSubmission/set',{accountId:S.acct,create:{s:{emailId:e.id,identityId:S.identity.id}},
          onSuccessUpdateEmail:{'#s':onOk}},'1']]).catch(x=>{err(x);return null});
      if(sr){
        const sub=resp(sr,'EmailSubmission/set');
        if(sub&&sub.created&&sub.created.s)sentN++;
        else if(out)await jmap([['Email/set',{accountId:S.acct,update:{[e.id]:{['mailboxIds/'+sch.id]:true,['mailboxIds/'+out.id]:null}}},'0']]).catch(()=>{});
      }
    }
    if(sentN){
      toast(sentN===1?'Scheduled mail sent':sentN+' scheduled mails sent');
      await refreshBoxes().catch(()=>{});
      if(!S.openThreadId)loadList(true).catch(()=>{});
    }
  }finally{dispatching=false}
}

/* ---------- important ---------- */
async function setImportant(tids,on){
  tids=tids&&tids.length?tids:(S.openThreadId?[S.openThreadId]:selThreads());
  const ids=threadEmailIds(tids);if(!ids.length)return;
  await applyWithUndo(ids,{['keywords/$important']:on?true:null},on?'Marked important':'Marked not important');
  S.sel.clear();
}

/* ---------- rail state (S◉LOCK behaviours) ---------- */
function applyRailState(){
  document.documentElement.style.setProperty('--railw',Math.max(170,Math.min(340,+SET.railW||238))+'px');
  $('app').classList.toggle('rail-min',!!SET.railMin);
  $('tb-menu-arrow').classList.toggle('flip',!!SET.railMin);
  $('tb-menu').title=SET.railMin?'Expand side panel':'Collapse side panel';
}
function toggleRail(){
  if(innerWidth<=860){$('rail').classList.toggle('open');return}
  SET.railMin=!SET.railMin;saveSettings();applyRailState();
}
function armRailDrag(){
  const h=document.createElement('div');h.className='rail-drag';h.title='Drag to resize';
  $('rail').appendChild(h);
  h.onmousedown=e=>{
    e.preventDefault();
    document.body.classList.add('rail-dragging');
    const left=$('rail').getBoundingClientRect().left;
    const move=ev=>{
      const w=ev.clientX-left;
      if(w<130){if(!SET.railMin){SET.railMin=true;applyRailState()}}
      else{
        if(SET.railMin){SET.railMin=false}
        SET.railW=Math.max(170,Math.min(340,w));
        applyRailState();
      }
    };
    const up=()=>{document.body.classList.remove('rail-dragging');saveSettings();
      removeEventListener('mousemove',move);removeEventListener('mouseup',up)};
    addEventListener('mousemove',move);addEventListener('mouseup',up);
  };
}

/* ---------- thread reader ---------- */
function showList(){
  $('thread-view').classList.add('hidden');$('list-view').classList.remove('hidden');
  const fv=$('files-view');if(fv)fv.classList.add('hidden');
  S.openThreadId=null;
  loadList(true).catch(()=>{});
}
async function openThread(tid){
  S.openThreadId=tid;
  const fv=$('files-view');if(fv)fv.classList.add('hidden');
  const rs=await jmap([
    ['Thread/get',{accountId:S.acct,ids:[tid]},'t'],
    ['Email/get',{accountId:S.acct,'#ids':{resultOf:'t',name:'Thread/get',path:'/list/*/emailIds'},
      properties:LIST_PROPS.concat(['cc','bcc','replyTo','sentAt','bodyValues','textBody','htmlBody','attachments','messageId','references','inReplyTo']),
      fetchHTMLBodyValues:true,fetchTextBodyValues:true,maxBodyValueBytes:1000000},'e']]);
  const th=(resp(rs,'Thread/get').list||[])[0];
  if(th)S.threadEmails[tid]=th.emailIds;
  const emails=(resp(rs,'Email/get').list||[]).sort((a,b)=>(a.receivedAt<b.receivedAt?-1:1));
  if(!emails.length)return;
  for(const e of emails){S.emailCache[e.id]=Object.assign(S.emailCache[e.id]||{},e);harvestAddrs(e)}
  $('list-view').classList.add('hidden');$('thread-view').classList.remove('hidden');
  $('th-subject').textContent=emails[emails.length-1].subject||'(no subject)';
  renderThreadLabels();
  const box=$('msgs');box.innerHTML='';
  emails.forEach((e,i)=>box.appendChild(msgEl(e,i===emails.length-1)));
  const unseen=emails.filter(e=>!(e.keywords&&e.keywords.$seen)).map(e=>e.id);
  if(unseen.length){
    const update={};for(const id of unseen)update[id]={['keywords/$seen']:true};
    jmap([['Email/set',{accountId:S.acct,update},'0']]).then(()=>refreshBoxes()).catch(()=>{});
  }
}
function renderThreadLabels(){
  const wrap=$('th-labels');wrap.innerHTML='';
  const tid=S.openThreadId;if(!tid)return;
  const ids=S.threadEmails[tid]||[];const seen=new Set();
  for(const id of ids){const e=S.emailCache[id];if(!e)continue;
    for(const bid of Object.keys(e.mailboxIds||{})){
      const b=S.boxes[bid];if(!b||b.role||seen.has(bid))continue;seen.add(bid);
      const chip=document.createElement('span');chip.className='chip chip-x';
      chip.style.setProperty('--hue',hueFor(b.name));
      chip.innerHTML=esc(b.name)+' <b>×</b>';
      chip.onclick=async()=>{
        const update={};for(const eid of ids)update[eid]={['mailboxIds/'+bid]:null};
        await jmap([['Email/set',{accountId:S.acct,update},'0']]).catch(err);
        for(const eid of ids)if(S.emailCache[eid]&&S.emailCache[eid].mailboxIds)delete S.emailCache[eid].mailboxIds[bid];
        renderThreadLabels();refreshBoxes().catch(()=>{});
      };
      wrap.appendChild(chip);
    }}
}
function msgEl(e,expanded){
  const el=document.createElement('article');el.className='msg'+(expanded?' open':'');
  const who=(e.from&&e.from[0])||{};
  const toLine=(e.to||[]).map(p=>p.name||p.email).join(', ');
  el.innerHTML=
    `<header class="msg-head">
      <span class="avatar" style="--hue:${hueFor(who.name||who.email||'')}">${esc((who.name||who.email||'?')[0].toUpperCase())}</span>
      <span class="msg-who"><b>${esc(who.name||who.email||'—')}</b><small>${esc(who.email||'')}</small>
        <small class="msg-to">to ${esc(toLine||'me')}</small></span>
      <span class="msg-date">${fmtDateLong(e.receivedAt)}</span>
      <span class="msg-headbtns">
        <button class="iconbtn m-star${e.keywords&&e.keywords.$flagged?' on':''}" title="Star"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z"/></svg></button>
        <button class="iconbtn m-reply" title="Reply (r)"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4"/></svg></button>
        <button class="iconbtn m-more" title="More"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
      </span>
    </header>
    <div class="msg-imgbar hidden"></div>
    <div class="msg-body"></div>
    <div class="msg-atts"></div>`;
  el.querySelector('.msg-head').onclick=ev=>{
    if(ev.target.closest('.iconbtn'))return;
    el.classList.toggle('open');
    if(el.classList.contains('open')&&!el.dataset.filled)fillBody(el,e);
  };
  el.querySelector('.m-star').onclick=ev=>{ev.stopPropagation();toggleStar(e).catch(err);
    ev.currentTarget.classList.toggle('on')};
  el.querySelector('.m-reply').onclick=ev=>{ev.stopPropagation();openCompose('reply',e)};
  el.querySelector('.m-more').onclick=ev=>{ev.stopPropagation();
    showMenu(ev.currentTarget,[
      {label:'Reply',onclick:()=>openCompose('reply',e)},
      {label:'Reply all',onclick:()=>openCompose('replyall',e)},
      {label:'Forward',onclick:()=>openCompose('forward',e)},
      '—',
      {label:(e.keywords&&e.keywords.$important)?'Not important':'Mark important',
        onclick:()=>setImportant([e.threadId],!(e.keywords&&e.keywords.$important)).catch(err)},
      {label:'Snooze…',onclick:()=>snoozeMenu($('th-snooze'),[e.threadId])},
      {label:'Mark unread from here',onclick:()=>setThreadsSeen([e.threadId],false).then(showList).catch(err)},
      {label:'Not spam',onclick:()=>bulkAct('notspam',[e.threadId]).catch(err)}])};
  if(expanded)fillBody(el,e);
  renderAtts(el,e);
  return el;
}
function bodyOf(e){
  const hv=(e.htmlBody||[]).map(p=>e.bodyValues&&e.bodyValues[p.partId]).find(v=>v&&v.value);
  if(hv)return{html:hv.value};
  const tv=(e.textBody||[]).map(p=>e.bodyValues&&e.bodyValues[p.partId]).find(v=>v&&v.value);
  return{text:tv?tv.value:''};
}
function fillBody(el,e){
  el.dataset.filled='1';
  const body=bodyOf(e),slot=el.querySelector('.msg-body');
  const sender=((e.from&&e.from[0])||{}).email||'';
  if(body.html!==undefined){
    let html=body.html,blocked=0;
    const allow=SET.images==='always'||SET.imgAllow[sender];
    if(!allow){
      html=html.replace(/(<img\b[^>]*?)\ssrc\s*=\s*(["'])(https?:\/\/[^"']*)\2/gi,
        (mm,pre,qq,url)=>{blocked++;return pre+' data-vf-src='+qq+url+qq});
    }
    const bar=el.querySelector('.msg-imgbar');
    if(blocked){
      bar.classList.remove('hidden');
      bar.innerHTML=`External images hidden. <button class="ib-show">Show images</button> <button class="ib-always">Always from ${esc(sender)}</button>`;
      bar.querySelector('.ib-show').onclick=()=>{unblockImgs(el);bar.classList.add('hidden')};
      bar.querySelector('.ib-always').onclick=()=>{SET.imgAllow[sender]=true;saveSettings();unblockImgs(el);bar.classList.add('hidden')};
    }
    const f=document.createElement('iframe');
    f.className='msg-frame';f.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
    f.srcdoc=`<!doctype html><meta charset="utf-8"><base target="_blank">`+
      `<style>body{margin:0;font:14px/1.55 -apple-system,'Segoe UI',sans-serif;color:#1d1d1f;word-break:break-word}`+
      `img{max-width:100%;height:auto}a{color:#1f6ff2}blockquote{border-left:3px solid #d9d9de;margin:8px 0;padding:2px 14px;color:#6e6e73}</style>`+html;
    f.onload=()=>{try{f.style.height=Math.min(f.contentDocument.body.scrollHeight+28,2600)+'px'}catch(_){f.style.height='420px'}};
    slot.innerHTML='';slot.appendChild(f);
  }else{
    slot.innerHTML=`<pre class="msg-text">${esc(body.text)}</pre>`;
  }
}
function unblockImgs(el){
  const f=el.querySelector('iframe.msg-frame');if(!f)return;
  try{const d=f.contentDocument;
    d.querySelectorAll('img[data-vf-src]').forEach(im=>{im.src=im.getAttribute('data-vf-src')});
    setTimeout(()=>{try{f.style.height=Math.min(d.body.scrollHeight+28,2600)+'px'}catch(_){}} ,600);
  }catch(_){}
}
function renderAtts(el,e){
  const atts=(e.attachments||[]).filter(a=>a.disposition!=='inline'||!a.cid);
  if(!atts.length)return;
  const wrap=el.querySelector('.msg-atts');
  for(const a of atts){
    const chip=document.createElement('a');chip.className='att';
    chip.href=downloadUrl(a.blobId,a.name);chip.target='_blank';
    chip.innerHTML=`<svg viewBox="0 0 24 24"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 5a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6L15 8.3"/></svg>`+
      `<span>${esc(a.name||'attachment')}</span><small>${fmtSize(a.size)}</small>`;
    wrap.appendChild(chip);
  }
}

/* ---------- utils ---------- */
function fmtDate(iso){
  const d=new Date(iso),now=new Date();
  if(d.toDateString()===now.toDateString())return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(d.getFullYear()===now.getFullYear())return d.toLocaleDateString([],{day:'numeric',month:'short'});
  return d.toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});
}
const fmtDateLong=iso=>new Date(iso).toLocaleString([],{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
const fmtSize=n=>!n?'':n<1024?n+' B':n<1048576?(n/1024).toFixed(0)+' KB':(n/1048576).toFixed(1)+' MB';
function updateTitle(){
  const inbox=S.byRole.inbox,n=inbox?(inbox.unreadThreads||inbox.unreadEmails||0):0;
  document.title=(n?`(${n}) `:'')+'VF Mail';
}

/* ---------- compose ---------- */
function openCompose(mode,ref){
  const cp=$('compose');cp.classList.remove('hidden','min','max');
  S.cpRefs=null;S.cpAtts=[];S.cpDirty=false;renderCpAtts();
  $('cp-to').value='';$('cp-cc').value='';$('cp-bcc').value='';$('cp-subject').value='';
  $('cp-cc-row').classList.add('hidden');$('cp-bcc-row').classList.add('hidden');
  $('cp-status').textContent='';$('cp-title').textContent='New message';
  populateComposeIdentities(mode,ref);
  populateComposeSignatures();
  const body=$('cp-body');body.innerHTML='';
  if(SET.textStyle){
    if(SET.textStyle.font)body.style.fontFamily=SET.textStyle.font;
    if(SET.textStyle.size)body.style.fontSize=SET.textStyle.size+'px';
    if(SET.textStyle.color)body.style.color=SET.textStyle.color;
  }
  if(mode&&ref){
    const from=(ref.from&&ref.from[0])||{};
    const meRe=new RegExp('^'+S.user.replace(/[.+]/g,'\\$&')+'$','i');
    if(mode==='reply'||mode==='replyall'){
      const rto=(ref.replyTo&&ref.replyTo.length?ref.replyTo:ref.from)||[];
      $('cp-to').value=rto.map(p=>p.email).join(', ');
      if(mode==='replyall'){
        const cc=(ref.to||[]).concat(ref.cc||[]).map(p=>p.email)
          .filter(a=>a&&!meRe.test(a)&&a!==$('cp-to').value);
        if(cc.length){$('cp-cc').value=[...new Set(cc)].join(', ');$('cp-cc-row').classList.remove('hidden')}
      }
      $('cp-subject').value=/^re:/i.test(ref.subject||'')?ref.subject:'Re: '+(ref.subject||'');
      S.cpRefs={inReplyTo:ref.messageId||null,references:(ref.references||[]).concat(ref.messageId||[])};
      $('cp-title').textContent='Reply';
    }else if(mode==='forward'){
      $('cp-subject').value=/^fwd?:/i.test(ref.subject||'')?ref.subject:'Fwd: '+(ref.subject||'');
      S.cpAtts=(ref.attachments||[]).filter(a=>a.blobId).map(a=>({blobId:a.blobId,name:a.name,type:a.type,size:a.size}));
      renderCpAtts();
      $('cp-title').textContent='Forward';
    }
    const b=bodyOf(ref);
    const orig=b.html!==undefined?b.html:`<pre style="white-space:pre-wrap;font:inherit">${esc(b.text)}</pre>`;
    const attr=`On ${fmtDateLong(ref.receivedAt)}, ${esc(from.name||from.email||'')} &lt;${esc(from.email||'')}&gt; wrote:`;
    const sig=sigById(SET.sigPrimaryReply);
    body.innerHTML=`<div><br></div>`+(sig?`<div class="vf-sig">${sig.html}</div>`:'')+
      `<div><br></div><div>${attr}</div><blockquote style="border-left:3px solid #d9d9de;margin:6px 0;padding:2px 14px;color:#555">${orig}</blockquote>`;
  }else{
    const sig=sigById(SET.sigPrimaryNew);
    if(sig)body.innerHTML=`<div><br></div><div><br></div><div class="vf-sig">${sig.html}</div>`;
  }
  (mode&&ref?body:$('cp-to')).focus();
  if(mode&&ref){const r=document.createRange();r.setStart(body,0);r.collapse(true);
    const s=getSelection();s.removeAllRanges();s.addRange(r)}
  armAutosave();
}
function populateComposeIdentities(mode,ref){
  const sel=$('cp-from'),ids=SET.identities||[];
  sel.innerHTML='';
  if(ids.length<=1){sel.classList.add('hidden');return}
  sel.classList.remove('hidden');
  for(const id of ids)sel.add(new Option((id.name?id.name+' ':'')+'<'+id.email+'>',id.id));
  let pick=SET.defaultIdentityId||(ids.find(x=>x.email===S.user)||ids[0]).id;
  if(SET.replyFromSame&&ref&&(mode==='reply'||mode==='replyall')){
    const to=(ref.to||[]).concat(ref.cc||[]);
    const hit=ids.find(x=>to.some(a=>(a.email||'').toLowerCase()===x.email.toLowerCase()));
    if(hit)pick=hit.id;
  }
  sel.value=pick;
  sel.onchange=()=>{const id=ids.find(x=>x.id===sel.value);if(id){S.identity=id}};
  const id=ids.find(x=>x.id===pick);if(id)S.identity=id;
}
function populateComposeSignatures(){
  const sel=$('cp-sig');sel.innerHTML='';
  if(!SET.signatures.length){sel.classList.add('hidden');return}
  sel.classList.remove('hidden');
  sel.add(new Option('No signature',''));
  for(const s of SET.signatures)sel.add(new Option(s.name,s.id));
  sel.value=SET.sigPrimaryNew||'';
  sel.onchange=()=>{
    const body=$('cp-body');
    const existing=body.querySelector('.vf-sig');if(existing)existing.remove();
    const s=sigById(sel.value);if(!s)return;
    const wrap=document.createElement('div');wrap.className='vf-sig';wrap.innerHTML=s.html;
    body.appendChild(document.createElement('br'));body.appendChild(wrap);
  };
}
function closeCompose(save){
  clearInterval(S.autosaveTimer);S.autosaveTimer=null;
  if(save&&S.cpDirty&&composeHasContent())saveDraft().catch(()=>{});
  $('compose').classList.add('hidden');
  S.draftId=null;S.cpAtts=[];S.cpRefs=null;S.cpDirty=false;
}
const composeHasContent=()=>!!($('cp-to').value.trim()||$('cp-subject').value.trim()||$('cp-body').innerText.trim());
function armAutosave(){
  clearInterval(S.autosaveTimer);
  S.autosaveTimer=setInterval(()=>{if(S.cpDirty&&composeHasContent())saveDraft().catch(()=>{})},30000);
}
const parseAddrs=v=>v.split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(a=>{
  const m=/^(.*?)[<\s]([^<>\s]+@[^<>\s]+)>?$/.exec(a);
  return m&&m[2]?{name:m[1].replace(/["<>]/g,'').trim()||null,email:m[2]}:{email:a}});
function buildEmailObject(extraKeywords,mailboxIds){
  const html=$('cp-body').innerHTML,text=$('cp-body').innerText;
  const bodyValues={t:{value:text},h:{value:html}};
  const alt={type:'multipart/alternative',subParts:[{partId:'t',type:'text/plain'},{partId:'h',type:'text/html'}]};
  const structure=S.cpAtts.length?
    {type:'multipart/mixed',subParts:[alt].concat(S.cpAtts.map(a=>({blobId:a.blobId,type:a.type||'application/octet-stream',name:a.name,disposition:'attachment'})))}:alt;
  const idn=S.identity||{};
  const o={mailboxIds,keywords:Object.assign({$seen:true},extraKeywords),
    from:[{name:idn.name||null,email:idn.email||S.user}],
    to:parseAddrs($('cp-to').value),subject:$('cp-subject').value,
    bodyValues,bodyStructure:structure};
  const cc=parseAddrs($('cp-cc').value),bcc=parseAddrs($('cp-bcc').value);
  if(cc.length)o.cc=cc;if(bcc.length)o.bcc=bcc;
  if(S.cpRefs){if(S.cpRefs.inReplyTo)o.inReplyTo=[].concat(S.cpRefs.inReplyTo);
    if(S.cpRefs.references&&S.cpRefs.references.length)o.references=S.cpRefs.references}
  return o;
}
async function saveDraft(){
  const drafts=S.byRole.drafts;if(!drafts)return;
  const obj=buildEmailObject({$draft:true},{[drafts.id]:true});
  const calls=[['Email/set',{accountId:S.acct,create:{d:obj},destroy:S.draftId?[S.draftId]:[]},'0']];
  const rs=await jmap(calls);
  const st=resp(rs,'Email/set');
  if(st.created&&st.created.d){S.draftId=st.created.d.id;S.cpDirty=false;
    $('cp-status').textContent='Draft saved '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
  else if(st.notCreated)$('cp-status').textContent='Draft save failed';
}
async function resumeDraft(id){
  const rs=await jmap([['Email/get',{accountId:S.acct,ids:[id],
    properties:LIST_PROPS.concat(['cc','bcc','bodyValues','textBody','htmlBody','attachments','messageId','references','inReplyTo']),
    fetchHTMLBodyValues:true,fetchTextBodyValues:true,maxBodyValueBytes:1000000},'0']]);
  const e=(resp(rs,'Email/get').list||[])[0];if(!e)return;
  openCompose(null,null);
  S.draftId=e.id;$('cp-title').textContent='Draft';
  $('cp-to').value=(e.to||[]).map(p=>p.email).join(', ');
  if(e.cc&&e.cc.length){$('cp-cc').value=e.cc.map(p=>p.email).join(', ');$('cp-cc-row').classList.remove('hidden')}
  if(e.bcc&&e.bcc.length){$('cp-bcc').value=e.bcc.map(p=>p.email).join(', ');$('cp-bcc-row').classList.remove('hidden')}
  $('cp-subject').value=e.subject||'';
  const b=bodyOf(e);
  $('cp-body').innerHTML=b.html!==undefined?b.html:`<pre style="white-space:pre-wrap;font:inherit">${esc(b.text)}</pre>`;
  S.cpAtts=(e.attachments||[]).filter(a=>a.blobId).map(a=>({blobId:a.blobId,name:a.name,type:a.type,size:a.size}));
  renderCpAtts();
  if(e.inReplyTo||e.references)S.cpRefs={inReplyTo:(e.inReplyTo||[])[0]||null,references:e.references||[]};
}
async function discardDraft(){
  const id=S.draftId;
  clearInterval(S.autosaveTimer);S.autosaveTimer=null;S.cpDirty=false;
  $('compose').classList.add('hidden');
  if(id){await jmap([['Email/set',{accountId:S.acct,destroy:[id]},'0']]).catch(()=>{});await afterMutate()}
  S.draftId=null;toast('Draft discarded');
}
function renderCpAtts(){
  const w=$('cp-atts');w.innerHTML='';
  S.cpAtts.forEach((a,i)=>{
    const c=document.createElement('span');c.className='att att-cp';
    c.innerHTML=`<span>${esc(a.name||'file')}</span><small>${fmtSize(a.size)}</small><b title="Remove">×</b>`;
    c.querySelector('b').onclick=()=>{S.cpAtts.splice(i,1);S.cpDirty=true;renderCpAtts()};
    w.appendChild(c);
  });
}
async function uploadFiles(files){
  for(const f of files){
    $('cp-status').textContent='Uploading '+f.name+'…';
    const r=await fetch(jmapUrl(`/jmap/upload/${S.acct}/`),{method:'POST',
      headers:{Authorization:'Basic '+S.token,'Content-Type':f.type||'application/octet-stream'},body:f});
    if(!r.ok){$('cp-status').textContent='Upload failed: '+f.name;continue}
    const j=await r.json();
    S.cpAtts.push({blobId:j.blobId,name:f.name,type:j.type||f.type,size:j.size});
    S.cpDirty=true;renderCpAtts();
  }
  $('cp-status').textContent='';
}
function sendNowRequest(){
  if(!parseAddrs($('cp-to').value).length)return toast('Add at least one recipient.');
  if(!S.identity)return toast('No sending identity on this account.');
  const obj=buildEmailObject({},{[S.byRole.drafts.id]:true});
  const oldDraft=S.draftId;
  clearInterval(S.autosaveTimer);S.autosaveTimer=null;
  $('compose').classList.add('hidden');
  S.draftId=null;S.cpAtts=[];S.cpDirty=false;
  const secs=+SET.undo||10;
  const timer=setTimeout(()=>{S.pendingSend=null;doSend(obj,oldDraft).catch(e=>{err(e);toast('Send failed — reopen from Drafts.')})},secs*1000);
  S.pendingSend={timer,obj,oldDraft};
  toast('Sending…','Undo',()=>{
    clearTimeout(timer);S.pendingSend=null;
    reopenFromObject(obj,oldDraft);
  },secs*1000+400);
}
function reopenFromObject(obj,oldDraft){
  openCompose(null,null);
  S.draftId=oldDraft;
  $('cp-to').value=(obj.to||[]).map(p=>p.email).join(', ');
  if(obj.cc){$('cp-cc').value=obj.cc.map(p=>p.email).join(', ');$('cp-cc-row').classList.remove('hidden')}
  if(obj.bcc){$('cp-bcc').value=obj.bcc.map(p=>p.email).join(', ');$('cp-bcc-row').classList.remove('hidden')}
  $('cp-subject').value=obj.subject||'';
  $('cp-body').innerHTML=obj.bodyValues.h.value;
  S.cpAtts=(obj.bodyStructure.subParts||[]).filter(p=>p.blobId).map(p=>({blobId:p.blobId,name:p.name,type:p.type}));
  if(obj.inReplyTo||obj.references)S.cpRefs={inReplyTo:(obj.inReplyTo||[])[0]||null,references:obj.references||[]};
  renderCpAtts();S.cpDirty=true;
}
async function doSend(obj,oldDraft){
  const drafts=S.byRole.drafts,sent=S.byRole.sent;
  const rs=await jmap([
    ['Email/set',{accountId:S.acct,create:{d:Object.assign({},obj,{keywords:Object.assign({},obj.keywords,{$draft:true})})},
      destroy:oldDraft?[oldDraft]:[]},'0'],
    ['EmailSubmission/set',{accountId:S.acct,
      create:{s:{emailId:'#d',identityId:S.identity.id}},
      onSuccessUpdateEmail:{'#s':{['mailboxIds/'+drafts.id]:null,['mailboxIds/'+(sent?sent.id:drafts.id)]:true,['keywords/$draft']:null}}},'1']]);
  const sub=resp(rs,'EmailSubmission/set');
  if(sub&&sub.notCreated&&sub.notCreated.s)throw new Error('Submission rejected: '+(sub.notCreated.s.description||sub.notCreated.s.type));
  toast('Sent');
  await afterMutate();
}

/* ---------- settings (Gmail-parity tabs) ---------- */
const SP_TABS=['general','labels','inbox','accounts','filters','fwd','themes','offline','advanced'];
function openSettings(tab){
  fillSettingsForm();
  const t=SP_TABS.includes(tab)?tab:(SET.lastTab||'general');
  showSpTab(t);
  $('settings').classList.remove('hidden');
}
function showSpTab(t){
  SET.lastTab=t;
  document.querySelectorAll('#sp-tabs .sp-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));
  const main=$('sp-main');main.innerHTML='';
  const build=SP_BUILDERS[t]||SP_BUILDERS.general;
  main.appendChild(build());
  main.scrollTop=0;
}
function fillSettingsForm(){
  loadVacation().catch(()=>{});
  loadIdentities().catch(()=>{});
  loadFilterScripts().catch(()=>{});
}
function fld(labelHtml,control){
  const w=document.createElement('div');w.className='sp-row';
  w.innerHTML=`<div class="sp-r-l">${labelHtml}</div>`;
  const r=document.createElement('div');r.className='sp-r-r';r.appendChild(control);
  w.appendChild(r);return w;
}
function sec(title,desc){
  const s=document.createElement('section');s.className='sp-sec';
  s.innerHTML=`<h3>${esc(title)}</h3>`+(desc?`<p class="sp-sec-desc">${esc(desc)}</p>`:'');
  return s;
}
function radios(name,opts,cur,onchange){
  const wrap=document.createElement('div');wrap.className='sp-radios';
  for(const [v,lab,hint] of opts){
    const id=name+'-'+v;
    const el=document.createElement('label');el.className='sp-radio';
    el.innerHTML=`<input type="radio" name="${name}" value="${v}"${cur===v?' checked':''}>
      <span class="sp-r-t"><b>${esc(lab)}</b>${hint?`<small>${esc(hint)}</small>`:''}</span>`;
    el.querySelector('input').onchange=e=>{if(e.target.checked)onchange(v)};
    wrap.appendChild(el);
  }
  return wrap;
}
function check(label,cur,onchange){
  const el=document.createElement('label');el.className='sp-check';
  el.innerHTML=`<input type="checkbox"${cur?' checked':''}><span>${esc(label)}</span>`;
  el.querySelector('input').onchange=e=>onchange(e.target.checked);
  return el;
}
function sel(opts,cur,onchange){
  const s=document.createElement('select');s.className='sp-sel';
  for(const [v,lab] of opts){const o=new Option(lab,v);if(v==cur)o.selected=true;s.add(o)}
  s.onchange=()=>onchange(s.value);return s;
}
function txt(cur,ph,onchange){
  const i=document.createElement('input');i.type='text';i.className='sp-txt';i.value=cur||'';i.placeholder=ph||'';
  i.oninput=()=>onchange(i.value);return i;
}
function longText(cur,rows,ph,onchange){
  const i=document.createElement('textarea');i.className='sp-txt sp-area';i.rows=rows||4;i.value=cur||'';i.placeholder=ph||'';
  i.oninput=()=>onchange(i.value);return i;
}

const SP_BUILDERS={
  general(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Language','Interface language. Browser default is used.');
    s1.appendChild(fld('Display language',sel([['en-GB','English (UK)'],['en-US','English (US)']],'en-GB',()=>{})));
    w.appendChild(s1);

    const s2=sec('Reading & density');
    s2.appendChild(fld('Density',
      radios('density',[['default','Default','Roomy list rows'],['comfortable','Comfortable','Standard row height'],['compact','Compact','Denser lists']],SET.density,v=>{SET.density=v;applyDensity()})));
    s2.appendChild(fld('Reading pane',
      radios('reading',[['off','No split · full-screen reader'],['right','Right of inbox','Reader to the right'],['below','Below inbox','Reader under the list']],SET.readingPane,v=>{SET.readingPane=v;applyReadingPane()})));
    s2.appendChild(fld('Conversation view',check('Group replies as conversations',SET.conv,v=>{SET.conv=v})));
    s2.appendChild(fld('Page size',sel([[25,'25 conversations'],[50,'50 conversations'],[100,'100 conversations']],SET.pageSize,v=>{SET.pageSize=+v})));
    w.appendChild(s2);

    const s3=sec('Sending');
    s3.appendChild(fld('Undo send window',sel([[5,'5 seconds'],[10,'10 seconds'],[20,'20 seconds'],[30,'30 seconds']],SET.undo,v=>{SET.undo=+v})));
    s3.appendChild(fld('Default reply behaviour',
      radios('defr',[['reply','Reply','Reply to sender only'],['replyall','Reply all','Include everyone on the thread']],SET.defaultReply,v=>{SET.defaultReply=v})));
    s3.appendChild(fld('Send & Archive',check('Show "Send & Archive" button in reply',SET.sendArchive,v=>{SET.sendArchive=v})));
    w.appendChild(s3);

    const s4=sec('Notifications');
    s4.appendChild(fld('Desktop notifications',
      radios('notif',[['off','None'],['new','New mail','Ping on every new mail'],['imp','Important only','Only $important flagged mail']],
        SET.notif===true?'new':(SET.notif==='imp'?'imp':(SET.notif==='new'?'new':'off')),
        v=>{SET.notif=(v==='off')?false:v;if(SET.notif&&'Notification' in window&&Notification.permission==='default')Notification.requestPermission()})));
    w.appendChild(s4);

    const s5=sec('Behaviour');
    s5.appendChild(fld('Hover actions',check('Show quick actions when hovering rows',SET.hoverActions,v=>{SET.hoverActions=v;applyHoverActions()})));
    s5.appendChild(fld('Keyboard shortcuts',check('Enable j/k, e, #, / and friends',SET.keyboardOn,v=>{SET.keyboardOn=v})));
    s5.appendChild(fld('Button labels',
      radios('btl',[['icons','Icons','Toolbar shows just icons'],['text','Text','Toolbar shows labels']],SET.btnLabels,v=>{SET.btnLabels=v;applyBtnLabels()})));
    s5.appendChild(fld('Auto-advance',
      radios('aa',[['newer','Go to newer conversation'],['older','Go to older conversation'],['list','Back to conversation list']],SET.autoAdvance,v=>{SET.autoAdvance=v})));
    s5.appendChild(fld('Personal level indicators',check('› sent to me · » only to me',SET.plIndicators,v=>{SET.plIndicators=v})));
    s5.appendChild(fld('Snippets',check('Show preview text in the list',SET.snippets,v=>{SET.snippets=v})));
    w.appendChild(s5);

    const s6=sec('Stars','Click the star to cycle through your enabled stars.');
    const starsWrap=document.createElement('div');starsWrap.className='sp-stars';
    starsWrap.appendChild(radios('stars',
      [['one','1 star','Yellow only'],['four','4 stars','Yellow, red, blue, green'],['all','All stars','Every colour + icons']],SET.stars,v=>{SET.stars=v}));
    s6.appendChild(starsWrap);
    w.appendChild(s6);

    const s7=sec('External images');
    s7.appendChild(fld('Images from unknown senders',
      radios('img',[['ask','Ask before displaying','Blocks trackers by default'],['always','Always display','Show every image']],SET.images,v=>{SET.images=v})));
    w.appendChild(s7);

    const s8=sec('Signatures','Manage multiple signatures. Pick which one is used for new mail and for replies.');
    const sigList=document.createElement('div');sigList.className='sig-list';
    function paintSigs(){
      sigList.innerHTML='';
      if(!SET.signatures.length){
        const e=document.createElement('div');e.className='sp-empty';e.textContent='No signatures yet — click "Add signature" below.';
        sigList.appendChild(e);return;
      }
      for(const s of SET.signatures){
        const card=document.createElement('div');card.className='sig-card';
        const head=document.createElement('div');head.className='sig-head';
        const nm=document.createElement('input');nm.type='text';nm.value=s.name;nm.className='sig-name';
        nm.oninput=()=>{s.name=nm.value};
        const badges=document.createElement('div');badges.className='sig-badges';
        if(SET.sigPrimaryNew===s.id)badges.innerHTML+='<span class="sig-badge">New mail</span>';
        if(SET.sigPrimaryReply===s.id)badges.innerHTML+='<span class="sig-badge">Reply / forward</span>';
        head.appendChild(nm);head.appendChild(badges);
        const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Delete';
        rm.onclick=()=>{if(!confirm('Delete signature "'+s.name+'"?'))return;
          SET.signatures=SET.signatures.filter(x=>x.id!==s.id);
          if(SET.sigPrimaryNew===s.id)SET.sigPrimaryNew='';
          if(SET.sigPrimaryReply===s.id)SET.sigPrimaryReply='';
          paintSigs()};
        head.appendChild(rm);
        card.appendChild(head);
        const body=document.createElement('div');body.className='st-sig sig-body';body.contentEditable=true;body.spellcheck=true;
        body.innerHTML=s.html||'';body.oninput=()=>{s.html=body.innerHTML};
        card.appendChild(body);
        const foot=document.createElement('div');foot.className='sig-foot';
        const setNew=document.createElement('button');setNew.className='btn-ghost';setNew.textContent=SET.sigPrimaryNew===s.id?'✓ Default for new mail':'Set default for new mail';
        setNew.onclick=()=>{SET.sigPrimaryNew=SET.sigPrimaryNew===s.id?'':s.id;paintSigs()};
        const setReply=document.createElement('button');setReply.className='btn-ghost';setReply.textContent=SET.sigPrimaryReply===s.id?'✓ Default for replies':'Set default for replies';
        setReply.onclick=()=>{SET.sigPrimaryReply=SET.sigPrimaryReply===s.id?'':s.id;paintSigs()};
        foot.appendChild(setNew);foot.appendChild(setReply);
        card.appendChild(foot);
        sigList.appendChild(card);
      }
    }
    paintSigs();
    s8.appendChild(sigList);
    const addSigBtn=document.createElement('button');addSigBtn.className='btn-ghost';addSigBtn.textContent='+ Add signature';
    addSigBtn.onclick=()=>{const n=prompt('Signature name','Signature '+(SET.signatures.length+1));if(!n)return;
      SET.signatures.push({id:uid('s'),name:n,html:''});paintSigs()};
    s8.appendChild(addSigBtn);
    w.appendChild(s8);

    const sTS=sec('Default text style','Compose uses this style unless you override it.');
    const tsGrid=document.createElement('div');tsGrid.className='ts-grid';
    tsGrid.appendChild(labelWrap('Font',sel([['','System default'],['Helvetica','Helvetica'],['Georgia','Georgia'],['Courier New','Courier New'],['ui-monospace','Monospace'],['\"Playfair Display\", serif','Playfair Display'],['\"Instrument\", serif','Instrument Italic']],SET.textStyle.font,v=>{SET.textStyle.font=v})));
    tsGrid.appendChild(labelWrap('Size',sel([[12,'Small'],[14,'Normal'],[16,'Large'],[20,'Huge']],SET.textStyle.size,v=>{SET.textStyle.size=+v})));
    const colWrap=document.createElement('div');colWrap.className='sp-lbl';
    colWrap.innerHTML='<span>Text colour</span>';
    const col=document.createElement('input');col.type='color';col.value=SET.textStyle.color||'#1d1d1f';
    col.oninput=()=>{SET.textStyle.color=col.value};
    colWrap.appendChild(col);tsGrid.appendChild(colWrap);
    const prev=document.createElement('div');prev.className='ts-preview';prev.textContent='The quick brown fox jumps over the lazy dog.';
    prev.style.fontFamily=SET.textStyle.font||'inherit';
    prev.style.fontSize=(SET.textStyle.size||14)+'px';
    prev.style.color=SET.textStyle.color||'inherit';
    sTS.appendChild(tsGrid);sTS.appendChild(prev);
    w.appendChild(sTS);

    const sTpl=sec('Templates','Save canned responses and paste them into new messages from the compose toolbar.');
    const tplList=document.createElement('div');tplList.className='sp-tbl';
    tplList.appendChild(tblHead(['Name','Actions']));
    if(!SET.templates.length){const e=document.createElement('div');e.className='sp-empty';e.textContent='No templates yet. Click "Save as template" from the compose window.';tplList.appendChild(e)}
    for(const t of SET.templates){
      const r=document.createElement('div');r.className='sp-tbl-row';
      r.innerHTML=`<span><b>${esc(t.name)}</b><small style="display:block;color:var(--dove);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc((t.html||'').replace(/<[^>]+>/g,' ').slice(0,120))}</small></span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const rn=document.createElement('button');rn.className='sp-linkbtn';rn.textContent='Rename';
      rn.onclick=()=>{const n=prompt('Rename template',t.name);if(!n)return;t.name=n;showSpTab('general')};
      const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Delete';
      rm.onclick=()=>{if(!confirm('Delete template?'))return;SET.templates=SET.templates.filter(x=>x.id!==t.id);showSpTab('general')};
      c.appendChild(rn);c.appendChild(rm);r.appendChild(c);tplList.appendChild(r);
    }
    sTpl.appendChild(tplList);
    w.appendChild(sTpl);

    const s9=sec('Vacation responder','Auto-reply while you\'re away.');
    const vacGrid=document.createElement('div');vacGrid.className='sp-grid';
    const on=document.createElement('input');on.type='checkbox';on.id='st-vac-on';
    const subj=document.createElement('input');subj.type='text';subj.id='st-vac-subject';subj.placeholder='Subject';
    const fromD=document.createElement('input');fromD.type='date';fromD.id='st-vac-from';
    const toD=document.createElement('input');toD.type='date';toD.id='st-vac-to';
    const body=document.createElement('textarea');body.id='st-vac-body';body.rows=4;body.placeholder='Message';
    const onWrap=document.createElement('label');onWrap.className='sp-check';onWrap.appendChild(on);
    const onT=document.createElement('span');onT.textContent='Vacation responder on';onWrap.appendChild(onT);
    vacGrid.appendChild(onWrap);
    vacGrid.appendChild(labelWrap('Subject',subj));
    vacGrid.appendChild(labelWrap('First day',fromD));
    vacGrid.appendChild(labelWrap('Last day',toD));
    vacGrid.appendChild(labelWrap('Message',body,true));
    s9.appendChild(vacGrid);
    w.appendChild(s9);
    return w;
  },
  labels(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('System folders','Show or hide the built-in folders in the side panel.');
    const sys=document.createElement('div');sys.className='sp-tbl';
    sys.appendChild(tblHead(['Folder','In panel']));
    for(const d of RAIL_DEF){
      const shown=!(SET['hide_'+d.key]);
      const r=document.createElement('div');r.className='sp-tbl-row';
      r.innerHTML=`<span>${esc(d.label)}</span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const b=document.createElement('button');b.className='sp-linkbtn';b.textContent=shown?'Shown':'Hidden';
      b.onclick=()=>{SET['hide_'+d.key]=shown;b.textContent=(!shown)?'Shown':'Hidden'};
      c.appendChild(b);r.appendChild(c);sys.appendChild(r);
    }
    s1.appendChild(sys);
    w.appendChild(s1);

    const s2=sec('Your labels','Rename, nest, or delete labels. Right-click a label in the side panel for the same menu.');
    const tbl=document.createElement('div');tbl.className='sp-tbl';
    tbl.appendChild(tblHead(['Label','Actions']));
    if(!S.labels.length){const e=document.createElement('div');e.className='sp-empty';e.textContent='No labels yet — create one from the side panel.';tbl.appendChild(e)}
    for(const b of S.labels){
      const r=document.createElement('div');r.className='sp-tbl-row';
      const path=labelPath(b);
      r.innerHTML=`<span class="sp-lb"><span class="rail-dot" style="background:hsl(${hueFor(path)} 62% 52%)"></span>${'—'.repeat(labelDepth(b))} ${esc(b.name)}</span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const rn=document.createElement('button');rn.className='sp-linkbtn';rn.textContent='Rename';
      rn.onclick=async()=>{const n=prompt('Rename label',b.name);if(!n)return;
        await jmap([['Mailbox/set',{accountId:S.acct,update:{[b.id]:{name:n}}},'0']]);await refreshBoxes();showSpTab('labels')};
      const sub=document.createElement('button');sub.className='sp-linkbtn';sub.textContent='Nest…';
      sub.onclick=async()=>{const n=prompt('Sub-label name');if(!n)return;
        await jmap([['Mailbox/set',{accountId:S.acct,create:{l:{name:n,parentId:b.id}}},'0']]).catch(err);
        await refreshBoxes();showSpTab('labels')};
      const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Delete';
      rm.onclick=async()=>{
        if(S.labels.some(x=>x.parentId===b.id))return toast('Delete sub-labels first.');
        if(!confirm('Delete label "'+b.name+'"? Mail keeps its other labels.'))return;
        const rs=await jmap([
          ['Email/query',{accountId:S.acct,filter:{inMailbox:b.id},limit:500},'q'],
          ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:['id','mailboxIds']},'e']]);
        const inLabel=resp(rs,'Email/get').list||[];
        if(inLabel.length){
          const update={};
          for(const e of inLabel){const patch={['mailboxIds/'+b.id]:null};
            if(Object.keys(e.mailboxIds||{}).length<=1&&S.byRole.archive)patch['mailboxIds/'+S.byRole.archive.id]=true;
            update[e.id]=patch}
          await jmap([['Email/set',{accountId:S.acct,update},'0']]);
        }
        await jmap([['Mailbox/set',{accountId:S.acct,destroy:[b.id]},'0']]);
        await refreshBoxes();showSpTab('labels');toast('Label deleted');
      };
      c.appendChild(rn);c.appendChild(sub);c.appendChild(rm);
      r.appendChild(c);tbl.appendChild(r);
    }
    s2.appendChild(tbl);
    const nl=document.createElement('button');nl.className='btn-ghost';nl.textContent='+ Create new label';
    nl.onclick=async()=>{await newLabel(null);showSpTab('labels')};
    s2.appendChild(nl);
    w.appendChild(s2);
    return w;
  },
  inbox(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Inbox type','Choose how your inbox is organised.');
    s1.appendChild(radios('itype',[
      ['default','Default','Newest first'],
      ['important','Important first','$important flagged mail at the top'],
      ['unread','Unread first','Unread mail at the top'],
      ['starred','Starred first','Starred mail at the top']],SET.inboxType,v=>{SET.inboxType=v}));
    w.appendChild(s1);

    const s2=sec('Reading pane','Where to show the message preview.');
    s2.appendChild(radios('rp',[
      ['off','Off','Reader replaces the list'],
      ['right','Right of inbox'],
      ['below','Below inbox']],SET.readingPane,v=>{SET.readingPane=v;applyReadingPane()}));
    w.appendChild(s2);

    const s3=sec('Markers');
    s3.appendChild(check('Show importance markers (◆) next to important mail',SET.importanceMarks,v=>{SET.importanceMarks=v}));
    s3.appendChild(check('Personal level indicators (› sent to me, » only to me)',SET.plIndicators,v=>{SET.plIndicators=v}));
    w.appendChild(s3);

    const s4=sec('Filtered mail');
    s4.appendChild(check('Override filters — still mark as important if usually treated as important',true,()=>{}));
    w.appendChild(s4);
    return w;
  },
  accounts(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Send mail as','Your identities. Add aliases if you have multiple addresses, or update the display name shown on outgoing mail.');
    const tbl=document.createElement('div');tbl.className='sp-tbl';
    tbl.appendChild(tblHead(['Identity','Actions']));
    for(const id of (SET.identities||[])){
      const r=document.createElement('div');r.className='sp-tbl-row';
      const isDefault=SET.defaultIdentityId===id.id||(!SET.defaultIdentityId&&id.email===S.user);
      r.innerHTML=`<span><b>${esc(id.name||'—')}${isDefault?' <span class="pill">Default</span>':''}</b><small style="display:block;color:var(--dove)">${esc(id.email)}${id.replyTo&&id.replyTo.length?' · reply-to: '+esc((id.replyTo[0]||{}).email||''):''}</small></span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const rn=document.createElement('button');rn.className='sp-linkbtn';rn.textContent='Edit';
      rn.onclick=async()=>{
        const n=prompt('Display name',id.name||'');if(n===null)return;
        const rt=prompt('Reply-to address (leave blank for none)',(id.replyTo&&id.replyTo[0]&&id.replyTo[0].email)||'');
        const upd={name:n};
        if(rt&&rt.trim())upd.replyTo=[{email:rt.trim(),name:null}];else if(rt==='')upd.replyTo=null;
        await jmap([['Identity/set',{accountId:S.acct,update:{[id.id]:upd}},'0']]).catch(err);
        await loadIdentities();showSpTab('accounts')};
      const md=document.createElement('button');md.className='sp-linkbtn';md.textContent=isDefault?'✓ Default':'Set default';
      md.onclick=()=>{SET.defaultIdentityId=id.id;showSpTab('accounts')};
      c.appendChild(md);c.appendChild(rn);
      if(id.email!==S.user){
        const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Remove';
        rm.onclick=async()=>{if(!confirm('Remove alias "'+id.email+'"?'))return;
          await jmap([['Identity/set',{accountId:S.acct,destroy:[id.id]},'0']]).catch(err);
          await loadIdentities();showSpTab('accounts')};
        c.appendChild(rm);
      }
      r.appendChild(c);tbl.appendChild(r);
    }
    s1.appendChild(tbl);
    const addAliasBtn=document.createElement('button');addAliasBtn.className='btn-ghost';addAliasBtn.textContent='+ Add another address';
    addAliasBtn.onclick=()=>openAliasModal();
    s1.appendChild(addAliasBtn);
    s1.appendChild(fld('Reply behaviour',
      radios('rfs',[
        ['same','Reply from the address the mail was sent to','Uses the alias that received the message'],
        ['default','Always reply from my default address','Uses the identity marked Default above']],
        SET.replyFromSame?'same':'default',v=>{SET.replyFromSame=v==='same'})));
    w.appendChild(s1);

    const s2=sec('Account & security','Manage your account and password.');
    const acct=document.createElement('div');acct.className='sp-info';
    acct.innerHTML=`<div><b>Address</b><span>${esc(S.user)}</span></div>
      <div><b>Server</b><span>mail.vfempire.com</span></div>
      <div><b>Storage</b><span id="sp-quota-line">loading…</span></div>`;
    s2.appendChild(acct);
    const cpBtn=document.createElement('button');cpBtn.className='btn-ghost';cpBtn.textContent='Change password';
    cpBtn.onclick=()=>toast('Contact the admin — self-serve password change is coming in Wave 3.');
    s2.appendChild(cpBtn);
    const soBtn=document.createElement('button');soBtn.className='btn-ghost danger';soBtn.textContent='Sign out';
    soBtn.style.marginLeft='10px';soBtn.onclick=()=>{if(confirm('Sign out of VF Mail?')){sessionStorage.clear();location.reload()}};
    s2.appendChild(soBtn);
    w.appendChild(s2);

    const s3=sec('Grant access to your account','Grant read-only access — coming in a later wave.');
    const p=document.createElement('div');p.className='sp-hint';p.textContent='Delegation lets a colleague read/reply on your behalf. Coming soon.';
    s3.appendChild(p);w.appendChild(s3);

    (async()=>{const rs=await jmap([['Quota/get',{accountId:S.acct},'0']]).catch(()=>null);
      const l=$('sp-quota-line');if(!l)return;
      if(!rs)return l.textContent='unknown';
      const q=(resp(rs,'Quota/get').list||[])[0];
      if(!q)return l.textContent='unknown';
      l.textContent=`${fmtSize(q.used||0)} of ${fmtSize(q.hardLimit||0)}`;
    })().catch(()=>{});
    return w;
  },
  filters(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Filters','Rules that run on every new message in your Inbox. Filters run client-side on refresh.');
    const tbl=document.createElement('div');tbl.className='sp-tbl';
    tbl.appendChild(tblHead(['Filter','Actions']));
    if(!SET.filters.length){const e=document.createElement('div');e.className='sp-empty';e.textContent='No filters yet. Click "Create new filter" below.';tbl.appendChild(e)}
    for(const f of SET.filters){
      const r=document.createElement('div');r.className='sp-tbl-row';
      r.innerHTML=`<span><b>${esc(f.name||'Untitled')}</b><small style="display:block;color:var(--dove);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc(filterSummary(f))}</small></span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const tog=document.createElement('button');tog.className='sp-linkbtn';tog.textContent=f.on===false?'Off':'On';
      tog.onclick=()=>{f.on=f.on===false;showSpTab('filters')};
      const ed=document.createElement('button');ed.className='sp-linkbtn';ed.textContent='Edit';
      ed.onclick=()=>openFilterModal(f);
      const dup=document.createElement('button');dup.className='sp-linkbtn';dup.textContent='Duplicate';
      dup.onclick=()=>{SET.filters.push(Object.assign({},f,{id:uid('f'),name:f.name+' (copy)'}));showSpTab('filters')};
      const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Delete';
      rm.onclick=()=>{if(!confirm('Delete filter "'+f.name+'"?'))return;SET.filters=SET.filters.filter(x=>x.id!==f.id);showSpTab('filters')};
      c.appendChild(tog);c.appendChild(ed);c.appendChild(dup);c.appendChild(rm);
      r.appendChild(c);tbl.appendChild(r);
    }
    s1.appendChild(tbl);
    const create=document.createElement('button');create.className='btn-ghost';create.textContent='+ Create new filter';
    create.onclick=()=>openFilterModal(null);
    s1.appendChild(create);
    const runNow=document.createElement('button');runNow.className='btn-ghost';runNow.style.marginLeft='8px';runNow.textContent='Run filters on Inbox now';
    runNow.onclick=async()=>{const n=await runFiltersNow();toast('Filters applied to '+n+' message'+(n===1?'':'s'))};
    s1.appendChild(runNow);
    w.appendChild(s1);

    const s2=sec('Blocked addresses','Messages from these addresses go straight to Spam.');
    const blk=document.createElement('div');blk.className='sp-tbl';
    blk.appendChild(tblHead(['Address','']));
    for(const a of (SET.blocked||[])){
      const r=document.createElement('div');r.className='sp-tbl-row';r.innerHTML=`<span>${esc(a)}</span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Unblock';
      rm.onclick=()=>{SET.blocked=SET.blocked.filter(x=>x!==a);saveSettings();showSpTab('filters')};
      c.appendChild(rm);r.appendChild(c);blk.appendChild(r);
    }
    if(!(SET.blocked||[]).length){const e=document.createElement('div');e.className='sp-empty';e.textContent='No blocked addresses.';blk.appendChild(e)}
    s2.appendChild(blk);
    const addRow=document.createElement('div');addRow.className='sp-inline';
    const addIn=document.createElement('input');addIn.type='email';addIn.placeholder='someone@example.com';addIn.className='sp-txt';
    const addBtn=document.createElement('button');addBtn.className='btn-ghost';addBtn.textContent='Block';
    addBtn.onclick=()=>{const v=(addIn.value||'').trim();if(!v)return;SET.blocked=(SET.blocked||[]).concat(v);saveSettings();showSpTab('filters')};
    addRow.appendChild(addIn);addRow.appendChild(addBtn);
    s2.appendChild(addRow);
    w.appendChild(s2);
    return w;
  },
  fwd(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Forwarding','Automatically forward every incoming message.');
    s1.appendChild(check('Forwarding enabled',SET.forwardOn,v=>{SET.forwardOn=v}));
    s1.appendChild(fld('Forward to',txt(SET.forwardTo,'someone@example.com',v=>{SET.forwardTo=v})));
    s1.appendChild(fld('And…',
      radios('fk',[
        ['keep','Keep a copy in Inbox'],
        ['archive','Archive the original'],
        ['read','Mark as read'],
        ['trash','Delete the original']],SET.forwardKeep,v=>{SET.forwardKeep=v})));
    w.appendChild(s1);

    const s2=sec('IMAP access','Use VF Mail from any IMAP client — Apple Mail, Thunderbird, Outlook.');
    const info=document.createElement('div');info.className='sp-info';
    info.innerHTML=`<div><b>Server</b><span>mail.vfempire.com</span></div>
      <div><b>Port · SSL</b><span>993 · required</span></div>
      <div><b>Username</b><span>${esc(S.user)}</span></div>
      <div><b>Password</b><span>your VF Mail password</span></div>`;
    s2.appendChild(info);
    w.appendChild(s2);

    const s3=sec('SMTP (send)','Outgoing mail server for third-party clients.');
    const info2=document.createElement('div');info2.className='sp-info';
    info2.innerHTML=`<div><b>Server</b><span>mail.vfempire.com</span></div>
      <div><b>Port · SSL</b><span>465 · required</span></div>
      <div><b>Auth</b><span>${esc(S.user)} + password</span></div>`;
    s3.appendChild(info2);
    w.appendChild(s3);

    const s4=sec('POP3','POP3 is available on port 995 (SSL) for clients that need it.');
    const info3=document.createElement('div');info3.className='sp-info';
    info3.innerHTML=`<div><b>Server</b><span>mail.vfempire.com</span></div>
      <div><b>Port · SSL</b><span>995 · required</span></div>`;
    s4.appendChild(info3);
    w.appendChild(s4);
    return w;
  },
  themes(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Theme');
    s1.appendChild(radios('th',[['light','Light','Bright, high contrast'],['dark','Dark','Easy on the eyes at night'],['auto','Auto','Follow the system']],SET.theme,v=>{SET.theme=v;applyTheme()}));
    w.appendChild(s1);

    const s2=sec('Accent colour','Buttons, links and highlights.');
    const swatches=document.createElement('div');swatches.className='sp-swatches';
    for(const c of ['#1f6ff2','#0b7d3a','#e63b19','#8324cc','#ea580c','#0891b2','#dc2626','#111']){
      const b=document.createElement('button');b.className='sw';b.style.background=c;b.title=c;
      if(SET.accent===c)b.classList.add('on');
      b.onclick=()=>{SET.accent=c;document.querySelectorAll('.sw').forEach(x=>x.classList.remove('on'));b.classList.add('on');applyAccent()};
      swatches.appendChild(b);
    }
    s2.appendChild(swatches);
    w.appendChild(s2);

    const s3=sec('Density');
    s3.appendChild(radios('td',[['default','Default'],['comfortable','Comfortable'],['compact','Compact']],SET.density,v=>{SET.density=v;applyDensity()}));
    w.appendChild(s3);

    const sBg=sec('Background','Pick a scene, upload your own image, or paste a URL. Applied behind the whole workspace.');

    const cur=document.createElement('div');cur.className='bg-current';
    const curPrev=document.createElement('div');curPrev.className='bg-preview big';curPrev.id='bg-current-prev';
    const curInfo=document.createElement('div');curInfo.className='bg-current-info';
    curInfo.innerHTML=`<div class="bg-cur-title">${SET.bgKind==='none'?'No background':(SET.bgKind==='upload'?'Your uploaded image':(SET.bgKind==='url'?'Custom URL':(BG_PRESETS.find(x=>x.key===SET.bgValue)||{}).label||'Background'))}</div>
      <div class="bg-cur-sub">${SET.bgKind==='none'?'Clean surface — the app blends with the theme.':'Live now'}</div>`;
    const curBtns=document.createElement('div');curBtns.className='bg-cur-btns';
    const clearBtn=document.createElement('button');clearBtn.className='btn-ghost';clearBtn.textContent='Remove background';
    clearBtn.onclick=()=>{SET.bgKind='none';SET.bgValue='';applyBg();refreshBgTab()};
    curBtns.appendChild(clearBtn);
    curInfo.appendChild(curBtns);
    cur.appendChild(curPrev);cur.appendChild(curInfo);
    sBg.appendChild(cur);

    const grid=document.createElement('div');grid.className='bg-grid';
    for(const bg of BG_PRESETS){
      const tile=document.createElement('button');tile.className='bg-tile';
      if(SET.bgKind==='preset'&&SET.bgValue===bg.key)tile.classList.add('on');
      const prev=document.createElement('div');prev.className='bg-preview';
      applyBgToNode(prev,{kind:'preset',value:bg.key});
      const label=document.createElement('span');label.className='bg-tile-lbl';label.textContent=bg.label;
      tile.appendChild(prev);tile.appendChild(label);
      tile.onclick=()=>{SET.bgKind='preset';SET.bgValue=bg.key;applyBg();refreshBgTab()};
      grid.appendChild(tile);
    }
    sBg.appendChild(grid);

    const upWrap=document.createElement('div');upWrap.className='bg-uploaders';

    const upTile=document.createElement('div');upTile.className='bg-uploader';
    upTile.innerHTML=`<div class="bg-up-icon"><svg viewBox="0 0 24 24"><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3M12 3v13M6 9l6-6 6 6"/></svg></div>
      <div class="bg-up-h">Upload from device</div>
      <div class="bg-up-p">JPG, PNG or WEBP · resized to 1920 wide</div>`;
    const upBtn=document.createElement('button');upBtn.className='btn-core';upBtn.textContent='Choose image…';
    const upIn=document.createElement('input');upIn.type='file';upIn.accept='image/*';upIn.style.display='none';
    upBtn.onclick=()=>upIn.click();
    upIn.onchange=async()=>{
      const f=upIn.files[0];if(!f)return;
      const url=await readImageAsDataURL(f,1920,true);
      SET.bgKind='upload';SET.bgValue=url;applyBg();refreshBgTab();
    };
    upTile.appendChild(upBtn);upTile.appendChild(upIn);

    const urlTile=document.createElement('div');urlTile.className='bg-uploader';
    urlTile.innerHTML=`<div class="bg-up-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/></svg></div>
      <div class="bg-up-h">Image from URL</div>
      <div class="bg-up-p">Paste a link to any image — Unsplash, your own CDN, anything.</div>`;
    const urlRow=document.createElement('div');urlRow.className='sp-inline';
    const urlIn=document.createElement('input');urlIn.type='url';urlIn.placeholder='https://images.unsplash.com/…';urlIn.className='sp-txt';
    urlIn.value=SET.bgKind==='url'?SET.bgValue:'';
    const urlBtn=document.createElement('button');urlBtn.className='btn-ghost';urlBtn.textContent='Apply';
    urlBtn.onclick=()=>{const v=(urlIn.value||'').trim();if(!v)return;SET.bgKind='url';SET.bgValue=v;applyBg();refreshBgTab()};
    urlRow.appendChild(urlIn);urlRow.appendChild(urlBtn);
    urlTile.appendChild(urlRow);

    upWrap.appendChild(upTile);upWrap.appendChild(urlTile);
    sBg.appendChild(upWrap);

    const finishing=document.createElement('div');finishing.className='bg-finish';
    finishing.appendChild(fld('Frosted glass',
      radios('bglr',[['off','Off','Solid app surfaces'],['light','Light','Subtle blur'],['heavy','Heavy','Deep blur behind rail & pane']],SET.bgBlur,v=>{SET.bgBlur=v;applyBg()})));
    const dimWrap=document.createElement('div');dimWrap.className='sp-row';
    dimWrap.innerHTML=`<div class="sp-r-l">Dim overlay</div>`;
    const dimR=document.createElement('div');dimR.className='sp-r-r bg-dim-r';
    const rng=document.createElement('input');rng.type='range';rng.min=0;rng.max=60;rng.value=SET.bgDim||0;
    const rngV=document.createElement('span');rngV.className='bg-dim-v';rngV.textContent=(SET.bgDim||0)+'%';
    rng.oninput=()=>{SET.bgDim=+rng.value;rngV.textContent=rng.value+'%';applyBg()};
    dimR.appendChild(rng);dimR.appendChild(rngV);dimWrap.appendChild(dimR);
    finishing.appendChild(dimWrap);
    sBg.appendChild(finishing);

    w.appendChild(sBg);

    // paint current preview
    setTimeout(()=>{const p=$('bg-current-prev');if(p)applyBgToNode(p,{kind:SET.bgKind,value:SET.bgValue})},0);
    return w;
  },
  offline(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Offline mail','Cache your recent mail so it opens instantly when you have no connection.');
    s1.appendChild(check('Enable offline mail',SET.offlineOn,v=>{SET.offlineOn=v}));
    s1.appendChild(fld('Sync last',sel([[7,'7 days'],[30,'30 days'],[90,'90 days'],[365,'1 year']],SET.offlineDays,v=>{SET.offlineDays=+v})));
    const p=document.createElement('div');p.className='sp-hint';
    p.innerHTML='Cache uses IndexedDB in your browser. Clearing browser data will remove it. Third-party attachments and inline images stay online-only.';
    s1.appendChild(p);
    w.appendChild(s1);
    return w;
  },
  advanced(){
    const w=document.createElement('div');w.className='sp-tab-body';
    const s1=sec('Auto-advance','After you archive or delete a conversation…');
    s1.appendChild(radios('aa',[['newer','Go to the newer conversation'],['older','Go to the older conversation'],['list','Back to the conversation list']],SET.autoAdvance,v=>{SET.autoAdvance=v}));
    w.appendChild(s1);

    const s2=sec('Multiple stars','Cycle through colours by clicking the star.');
    s2.appendChild(radios('mstar',[['one','Just yellow'],['four','Four colours'],['all','All 12 stars & icons']],SET.stars,v=>{SET.stars=v}));
    w.appendChild(s2);

    const s3=sec('Send cancellation window (legacy)','Applies when Undo isn\'t explicitly configured in General.');
    s3.appendChild(fld('Undo window',sel([[5,'5s'],[10,'10s'],[20,'20s'],[30,'30s']],SET.undo,v=>{SET.undo=+v})));
    w.appendChild(s3);

    const sMib=sec('Multiple Inboxes','Add extra sections underneath your Inbox. Each section runs a search query.');
    const mibTbl=document.createElement('div');mibTbl.className='sp-tbl';
    mibTbl.appendChild(tblHead(['Title','Query']));
    for(let i=0;i<(SET.mib||[]).length;i++){
      const m=SET.mib[i];
      const r=document.createElement('div');r.className='sp-tbl-row';
      r.innerHTML=`<span><b>${esc(m.title||'Untitled')}</b></span>`;
      const c=document.createElement('div');c.className='sp-tbl-c';
      c.innerHTML=`<code style="color:var(--dove);font-size:12px">${esc(m.query||'')}</code>`;
      const rm=document.createElement('button');rm.className='sp-linkbtn danger';rm.textContent='Remove';
      rm.onclick=()=>{SET.mib.splice(i,1);showSpTab('advanced')};
      c.appendChild(rm);r.appendChild(c);mibTbl.appendChild(r);
    }
    if(!(SET.mib||[]).length){const e=document.createElement('div');e.className='sp-empty';e.textContent='No extra inbox sections.';mibTbl.appendChild(e)}
    sMib.appendChild(mibTbl);
    const addMib=document.createElement('button');addMib.className='btn-ghost';addMib.textContent='+ Add section';
    addMib.onclick=()=>{const title=prompt('Section title','Starred');if(!title)return;
      const q=prompt('Search query (uses inbox search syntax)','is:starred');if(!q)return;
      (SET.mib=SET.mib||[]).push({title,query:q});showSpTab('advanced')};
    sMib.appendChild(addMib);
    w.appendChild(sMib);

    const s4=sec('Diagnostics');
    s4.appendChild(fld('Account ID',txt(S.acct||'',null,()=>{})));
    s4.appendChild(fld('Signed in as',txt(S.user||'',null,()=>{})));
    w.appendChild(s4);
    return w;
  }
};
function labelWrap(t,el,full){
  const l=document.createElement('label');l.className='sp-lbl'+(full?' full':'');
  const span=document.createElement('span');span.textContent=t;l.appendChild(span);l.appendChild(el);return l;
}
function tblHead(cols){const h=document.createElement('div');h.className='sp-tbl-head';
  for(const c of cols){const s=document.createElement('span');s.textContent=c;h.appendChild(s)}return h}

async function loadVacation(){
  const rs=await jmap([['VacationResponse/get',{accountId:S.acct},'0']],[VAC]).catch(()=>null);
  if(!rs)return;
  const v=(resp(rs,'VacationResponse/get').list||[])[0];if(!v)return;
  const on=$('st-vac-on'),subj=$('st-vac-subject'),body=$('st-vac-body'),fromD=$('st-vac-from'),toD=$('st-vac-to');
  if(on)on.checked=!!v.isEnabled;
  if(subj)subj.value=v.subject||'';
  if(body)body.value=v.textBody||'';
  if(fromD)fromD.value=v.fromDate?v.fromDate.slice(0,10):'';
  if(toD)toD.value=v.toDate?v.toDate.slice(0,10):'';
}
async function loadIdentities(){
  const rs=await jmap([['Identity/get',{accountId:S.acct,ids:null},'0']]).catch(()=>null);
  if(!rs)return;
  SET.identities=resp(rs,'Identity/get').list||[];
}
async function loadFilterScripts(){/* no-op — script kept in SET._sieve until save */}

async function saveSettingsSheet(){
  saveSettings();
  applyDensity();applyReadingPane();applyBtnLabels();applyTheme();applyAccent();applyBg();applyHoverActions();applyNotif();
  const vacOn=$('st-vac-on');
  if(vacOn){
    const upd={isEnabled:vacOn.checked,
      subject:$('st-vac-subject').value||null,
      textBody:$('st-vac-body').value||null,
      fromDate:$('st-vac-from').value?$('st-vac-from').value+'T00:00:00Z':null,
      toDate:$('st-vac-to').value?$('st-vac-to').value+'T23:59:59Z':null};
    await jmap([['VacationResponse/set',{accountId:S.acct,update:{singleton:upd}},'0']],[VAC]).catch(()=>{});
  }
  if(S.identity){
    const sigTxt=document.createElement('div');sigTxt.innerHTML=SET.sig||'';
    await jmap([['Identity/set',{accountId:S.acct,
      update:{[S.identity.id]:{
        name:SET.displayName||S.identity.name,
        htmlSignature:SET.sig||'',
        textSignature:sigTxt.innerText||''}}},'0']]).catch(()=>{});
  }
  $('st-status').textContent='Saved';
  setTimeout(()=>{$('st-status').textContent=''},3000);
  updateAccountAvatar();
}
function applyDensity(){document.body.setAttribute('data-density',SET.density||'default')}
function applyReadingPane(){document.body.setAttribute('data-pane',SET.readingPane||'off')}
function applyBtnLabels(){document.body.setAttribute('data-btn',SET.btnLabels||'icons')}
function applyTheme(){
  const t=SET.theme==='auto'?(matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):(SET.theme||'light');
  document.documentElement.setAttribute('data-theme',t);
}
function applyAccent(){document.documentElement.style.setProperty('--core',SET.accent||'#1f6ff2');
  const c=SET.accent||'#1f6ff2';
  document.documentElement.style.setProperty('--core-deep',shade(c,-14));}
const BG_PRESETS=[
  {key:'aurora',label:'Aurora',bg:'linear-gradient(135deg,#0f172a 0%,#1e293b 30%,#4c1d95 60%,#22d3ee 100%)'},
  {key:'sunrise',label:'Sunrise',bg:'linear-gradient(135deg,#fee2b3 0%,#fda4af 50%,#c084fc 100%)'},
  {key:'ocean',label:'Ocean',bg:'linear-gradient(160deg,#0ea5e9 0%,#0284c7 40%,#0e7490 100%)'},
  {key:'forest',label:'Forest',bg:'linear-gradient(180deg,#052e16 0%,#166534 55%,#65a30d 100%)'},
  {key:'rose',label:'Rose',bg:'linear-gradient(140deg,#fecdd3 0%,#f472b6 50%,#be185d 100%)'},
  {key:'slate',label:'Slate',bg:'linear-gradient(180deg,#e2e8f0 0%,#94a3b8 55%,#334155 100%)'},
  {key:'espresso',label:'Espresso',bg:'radial-gradient(1200px 800px at 20% 15%,#3f2a1f 0%,#1a0f0a 60%,#0a0605 100%)'},
  {key:'cotton',label:'Cotton',bg:'linear-gradient(180deg,#ffffff 0%,#f5f5f7 60%,#e6e8ec 100%)'},
  {key:'peach',label:'Peach',bg:'linear-gradient(160deg,#ffedd5 0%,#fdba74 50%,#fb923c 100%)'},
  {key:'midnight',label:'Midnight',bg:'linear-gradient(180deg,#020617 0%,#0f172a 55%,#1e3a8a 100%)'},
  {key:'sand',label:'Sand',bg:'linear-gradient(180deg,#f8f5ee 0%,#e9dfc7 55%,#c9b78a 100%)'},
  {key:'lavender',label:'Lavender',bg:'linear-gradient(160deg,#ede9fe 0%,#c4b5fd 50%,#8b5cf6 100%)'},
  {key:'ember',label:'Ember',bg:'radial-gradient(900px 700px at 70% 20%,#7c2d12 0%,#450a0a 60%,#000000 100%)'},
  {key:'mint',label:'Mint',bg:'linear-gradient(160deg,#ecfeff 0%,#67e8f9 50%,#14b8a6 100%)'},
  {key:'noir',label:'Noir',bg:'radial-gradient(1000px 700px at 50% 0%,#111 0%,#000 100%)'},
  {key:'grid',label:'Grid',bg:'#f5f5f7 url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22><path d=%22M40 0H0v40%22 fill=%22none%22 stroke=%22%23dfe1e6%22 stroke-width=%221%22/></svg>") repeat'},
  {key:'dots',label:'Dots',bg:'#0f172a radial-gradient(#334155 1.2px,transparent 1.4px) 0 0/22px 22px'},
  {key:'waves',label:'Waves',bg:'#1e40af url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%2280%22><path d=%22M0 40 Q30 10 60 40 T120 40%22 fill=%22none%22 stroke=%22%233b82f6%22 stroke-width=%221.5%22 opacity=%220.55%22/><path d=%22M0 60 Q30 30 60 60 T120 60%22 fill=%22none%22 stroke=%22%2360a5fa%22 stroke-width=%221.5%22 opacity=%220.55%22/></svg>") repeat'},
];
function bgCssFor(kind,value){
  if(kind==='preset'){const p=BG_PRESETS.find(x=>x.key===value);return p?p.bg:''}
  if(kind==='upload'||kind==='url'){if(!value)return '';return `url("${String(value).replace(/"/g,'')}") center/cover no-repeat`}
  return '';
}
function applyBgToNode(node,{kind,value}){
  const css=bgCssFor(kind,value);
  node.style.background=css||'linear-gradient(135deg,#f5f5f7,#e4e6ea)';
}
function applyBg(){
  const has=SET.bgKind!=='none'&&!!SET.bgValue;
  if(has){
    const css=bgCssFor(SET.bgKind,SET.bgValue);
    document.body.style.background=css;
    document.body.style.backgroundAttachment='fixed';
  }else{
    document.body.style.background='';
    document.body.style.backgroundAttachment='';
  }
  document.body.style.setProperty('--bg-dim',(SET.bgDim||0)/100);
  document.body.classList.toggle('has-bg',has);
  document.body.setAttribute('data-blur',has?(SET.bgBlur||'light'):'off');
  saveSettings();
}
function refreshBgTab(){if(SET.lastTab==='themes')showSpTab('themes')}
function applyHoverActions(){document.body.classList.toggle('no-hover',!SET.hoverActions)}
function applyNotif(){
  if((SET.notif==='new'||SET.notif==='imp'||SET.notif===true)&&'Notification' in window&&Notification.permission==='default')Notification.requestPermission();
}
function shade(hex,pct){
  const m=/^#?([0-9a-f]{6})$/i.exec(hex);if(!m)return hex;
  let n=parseInt(m[1],16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  const f=pct/100;
  const app=v=>Math.max(0,Math.min(255,Math.round(v+(pct<0?v:255-v)*f)));
  return '#'+((app(r)<<16)|(app(g)<<8)|app(b)).toString(16).padStart(6,'0');
}
function applyAllVisualSettings(){applyDensity();applyReadingPane();applyBtnLabels();applyTheme();applyAccent();applyBg();applyHoverActions()}

/* ---------- filters engine + modal ---------- */
function filterSummary(f){
  const w=f.when||{},t=f.then||{};
  const parts=[];
  if(w.from)parts.push('From: '+w.from);
  if(w.to)parts.push('To: '+w.to);
  if(w.subject)parts.push('Subject: '+w.subject);
  if(w.words)parts.push('Has: '+w.words);
  if(w.notWords)parts.push('Not: '+w.notWords);
  if(w.hasAtt)parts.push('Has attachment');
  if(w.size)parts.push('≥ '+fmtSize(w.size));
  const acts=[];
  if(t.skipInbox)acts.push('Archive');
  if(t.markRead)acts.push('Mark read');
  if(t.star)acts.push('Star');
  if(t.alwaysImportant)acts.push('Mark important');
  if(t.neverImportant)acts.push('Not important');
  if(t.neverSpam)acts.push('Never spam');
  if(t.trash)acts.push('Delete');
  if(t.label){const b=S.boxes[t.label];if(b)acts.push('Label: '+labelPath(b))}
  if(t.forward)acts.push('Forward → '+t.forward);
  return (parts.join(' · ')||'anything')+' → '+(acts.join(' + ')||'nothing');
}
function matchesFilter(f,e){
  const w=f.when||{};
  const has=(hay,needle)=>{if(!needle)return true;const n=needle.toLowerCase();
    return (hay||'').toLowerCase().includes(n)};
  const addrList=xs=>((xs||[]).map(a=>(a&&(a.email||''))+' '+(a&&(a.name||''))).join(' ')).toLowerCase();
  if(w.from&&!addrList(e.from).includes(w.from.toLowerCase()))return false;
  if(w.to&&!(addrList(e.to)+' '+addrList(e.cc)).includes(w.to.toLowerCase()))return false;
  if(w.subject&&!has(e.subject,w.subject))return false;
  const body=(e.subject||'')+' '+(e.preview||'');
  if(w.words){const terms=w.words.split(/\s+/).filter(Boolean);
    if(!terms.every(t=>body.toLowerCase().includes(t.toLowerCase())))return false}
  if(w.notWords){const terms=w.notWords.split(/\s+/).filter(Boolean);
    if(terms.some(t=>body.toLowerCase().includes(t.toLowerCase())))return false}
  if(w.hasAtt&&!e.hasAttachment)return false;
  if(w.size&&(e.size||0)<w.size)return false;
  return true;
}
async function runFiltersNow(){
  const active=SET.filters.filter(f=>f.on!==false);
  if(!active.length||!S.byRole.inbox)return 0;
  const rs=await jmap([
    ['Email/query',{accountId:S.acct,filter:{inMailbox:S.byRole.inbox.id},limit:200,
      sort:[{property:'receivedAt',isAscending:false}]},'q'],
    ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},
      properties:LIST_PROPS.concat(['cc','size'])},'e']]);
  const list=resp(rs,'Email/get').list||[];
  let touched=0;
  for(const e of list){
    for(const f of active){
      if(matchesFilter(f,e)){
        await applyFilterAction(f,[e.id]).catch(err);
        touched++;break;
      }
    }
  }
  SET.filtersLastRun=Date.now();saveSettings();
  await afterMutate();
  return touched;
}
async function applyFilterAction(f,ids){
  const t=f.then||{};const patch={};
  if(t.markRead)patch['keywords/$seen']=true;
  if(t.star)patch['keywords/$flagged']=true;
  if(t.alwaysImportant)patch['keywords/$important']=true;
  if(t.neverImportant)patch['keywords/$important']=null;
  if(t.label)patch['mailboxIds/'+t.label]=true;
  if(t.skipInbox&&S.byRole.archive){
    if(S.byRole.inbox)patch['mailboxIds/'+S.byRole.inbox.id]=null;
    patch['mailboxIds/'+S.byRole.archive.id]=true;
  }
  if(t.trash&&S.byRole.trash){
    for(const b of Object.keys(S.boxes))patch['mailboxIds/'+b]=null;
    patch['mailboxIds/'+S.byRole.trash.id]=true;
  }
  if(Object.keys(patch).length){
    const update={};for(const id of ids)update[id]=patch;
    await jmap([['Email/set',{accountId:S.acct,update},'0']]);
  }
  if(t.forward&&S.identity){
    /* build a forward as new draft via EmailSubmission */
    const rs=await jmap([['Email/get',{accountId:S.acct,ids,
      properties:LIST_PROPS.concat(['cc','bcc','bodyValues','textBody','htmlBody','messageId','references']),
      fetchHTMLBodyValues:true,fetchTextBodyValues:true,maxBodyValueBytes:1000000},'0']]).catch(()=>null);
    if(rs){
      const drafts=S.byRole.drafts,sent=S.byRole.sent;
      for(const e of resp(rs,'Email/get').list||[]){
        const b=bodyOf(e);
        const html=b.html!==undefined?b.html:'<pre>'+esc(b.text)+'</pre>';
        const bodyValues={t:{value:e.subject+'\n\n[forwarded by filter]'},h:{value:'<p><em>Forwarded by filter "'+esc(f.name)+'"</em></p>'+html}};
        const obj={mailboxIds:{[drafts.id]:true},keywords:{$seen:true,$draft:true},
          from:[{name:null,email:S.user}],to:[{email:t.forward}],subject:'Fwd: '+(e.subject||''),
          bodyValues,bodyStructure:{type:'multipart/alternative',subParts:[{partId:'t',type:'text/plain'},{partId:'h',type:'text/html'}]}};
        await jmap([
          ['Email/set',{accountId:S.acct,create:{d:obj}},'0'],
          ['EmailSubmission/set',{accountId:S.acct,create:{s:{emailId:'#d',identityId:S.identity.id}},
            onSuccessUpdateEmail:{'#s':{['mailboxIds/'+drafts.id]:null,['mailboxIds/'+(sent?sent.id:drafts.id)]:true,['keywords/$draft']:null}}},'1']]).catch(err);
      }
    }
  }
}

function openFilterModal(f){
  const isNew=!f;
  const draft=f?JSON.parse(JSON.stringify(f)):{id:uid('f'),name:'',on:true,when:{},then:{}};
  const m=$('filter-modal');const body=$('filter-body');body.innerHTML='';
  $('filter-title').textContent=isNew?'New filter':'Edit filter';
  const nm=document.createElement('input');nm.type='text';nm.placeholder='Filter name';nm.value=draft.name;nm.className='sp-txt';nm.style.maxWidth='none';nm.style.marginBottom='14px';
  nm.oninput=()=>{draft.name=nm.value};
  body.appendChild(nm);
  body.appendChild(sectionSubhead('When…'));
  const grid=document.createElement('div');grid.className='fm-grid';
  const mkTxt=(k,ph)=>{const i=document.createElement('input');i.type='text';i.placeholder=ph;i.value=draft.when[k]||'';i.className='sp-txt';
    i.oninput=()=>{draft.when[k]=i.value};return i};
  grid.appendChild(labelWrap('From',mkTxt('from','name or address contains')));
  grid.appendChild(labelWrap('To / Cc',mkTxt('to','name or address contains')));
  grid.appendChild(labelWrap('Subject',mkTxt('subject','contains')));
  grid.appendChild(labelWrap('Has the words',mkTxt('words','all words present')));
  grid.appendChild(labelWrap('Doesn\'t have',mkTxt('notWords','none of these words')));
  const sizeI=document.createElement('input');sizeI.type='number';sizeI.min=0;sizeI.value=draft.when.size?Math.round((draft.when.size||0)/1024):'';sizeI.placeholder='KB';sizeI.className='sp-txt';
  sizeI.oninput=()=>{draft.when.size=sizeI.value?(+sizeI.value*1024):0};
  grid.appendChild(labelWrap('Size ≥ (KB)',sizeI));
  const attC=document.createElement('label');attC.className='sp-check';
  attC.innerHTML='<input type="checkbox"'+(draft.when.hasAtt?' checked':'')+'> Has attachment';
  attC.querySelector('input').onchange=e=>{draft.when.hasAtt=e.target.checked};
  grid.appendChild(attC);
  body.appendChild(grid);
  body.appendChild(sectionSubhead('Then do the following…'));
  const acts=document.createElement('div');acts.className='fm-acts';
  const mkC=(k,lab)=>{const l=document.createElement('label');l.className='sp-check';
    l.innerHTML='<input type="checkbox"'+(draft.then[k]?' checked':'')+'><span>'+esc(lab)+'</span>';
    l.querySelector('input').onchange=e=>{draft.then[k]=e.target.checked};
    return l};
  acts.appendChild(mkC('skipInbox','Skip Inbox (archive)'));
  acts.appendChild(mkC('markRead','Mark as read'));
  acts.appendChild(mkC('star','Star it'));
  acts.appendChild(mkC('alwaysImportant','Always mark as important'));
  acts.appendChild(mkC('neverImportant','Never mark as important'));
  acts.appendChild(mkC('neverSpam','Never send to spam'));
  acts.appendChild(mkC('trash','Delete it'));
  const labRow=document.createElement('div');labRow.className='fm-actrow';
  const labC=document.createElement('label');labC.className='sp-check';
  labC.innerHTML='<input type="checkbox"'+(draft.then.label?' checked':'')+'><span>Apply label</span>';
  const labSel=document.createElement('select');labSel.className='sp-sel';labSel.style.marginLeft='8px';labSel.style.maxWidth='260px';
  labSel.add(new Option('— pick a label —',''));
  for(const b of S.labels)labSel.add(new Option(labelPath(b),b.id));
  labSel.value=draft.then.label||'';
  labSel.onchange=()=>{draft.then.label=labSel.value||''};
  labC.querySelector('input').onchange=e=>{if(!e.target.checked)draft.then.label='';else if(!draft.then.label&&S.labels[0]){draft.then.label=S.labels[0].id;labSel.value=S.labels[0].id}};
  labRow.appendChild(labC);labRow.appendChild(labSel);
  acts.appendChild(labRow);
  const fwdRow=document.createElement('div');fwdRow.className='fm-actrow';
  const fwdC=document.createElement('label');fwdC.className='sp-check';
  fwdC.innerHTML='<input type="checkbox"'+(draft.then.forward?' checked':'')+'><span>Forward to</span>';
  const fwdIn=document.createElement('input');fwdIn.type='email';fwdIn.className='sp-txt';fwdIn.style.marginLeft='8px';fwdIn.placeholder='address@example.com';
  fwdIn.value=draft.then.forward||'';fwdIn.oninput=()=>{draft.then.forward=fwdIn.value};
  fwdC.querySelector('input').onchange=e=>{if(!e.target.checked)draft.then.forward=''};
  fwdRow.appendChild(fwdC);fwdRow.appendChild(fwdIn);
  acts.appendChild(fwdRow);
  body.appendChild(acts);
  m.classList.remove('hidden');
  $('filter-save').onclick=()=>{
    if(!draft.name.trim())draft.name='Filter '+(SET.filters.length+1);
    const idx=SET.filters.findIndex(x=>x.id===draft.id);
    if(idx>=0)SET.filters[idx]=draft;else SET.filters.push(draft);
    saveSettings();m.classList.add('hidden');showSpTab('filters');
    toast('Filter saved');
  };
  $('filter-cancel').onclick=()=>m.classList.add('hidden');
}
function sectionSubhead(t){const d=document.createElement('div');d.className='fm-sub';d.textContent=t;return d}

/* ---------- alias modal ---------- */
function openAliasModal(){
  const m=$('alias-modal');
  $('alias-email').value='';$('alias-name').value='';$('alias-replyto').value='';
  m.classList.remove('hidden');
  $('alias-save').onclick=async()=>{
    const email=$('alias-email').value.trim(),name=$('alias-name').value.trim(),rt=$('alias-replyto').value.trim();
    if(!email||!/@/.test(email))return toast('Enter a valid email address');
    const create={a:{email,name:name||null,replyTo:rt?[{email:rt,name:null}]:null}};
    const rs=await jmap([['Identity/set',{accountId:S.acct,create},'0']]).catch(e=>{toast('Could not create alias: '+e.message);return null});
    if(!rs)return;
    const made=resp(rs,'Identity/set').created;
    if(!made||!made.a)return toast('Server rejected the alias');
    await loadIdentities();m.classList.add('hidden');showSpTab('accounts');
    toast('Alias added');
  };
  $('alias-cancel').onclick=()=>m.classList.add('hidden');
  $('alias-close').onclick=()=>m.classList.add('hidden');
}

/* ---------- templates menu (attached to compose) ---------- */
function openTemplatesMenu(anchor){
  const items=[];
  for(const t of SET.templates){
    items.push({label:t.name,onclick:()=>insertTemplate(t)});
  }
  if(SET.templates.length)items.push('—');
  items.push({label:'Save current draft as template…',onclick:()=>saveCurrentAsTemplate()});
  items.push({label:'Manage templates in Settings',onclick:()=>{closeCompose(false);openSettings('general')}});
  showMenu(anchor,items);
}
async function openQuickAttachPicker(anchor){
  await ensureFilesIndex().catch(()=>{});
  const files=(S.filesIndex||[]).slice(0,60);
  if(!files.length)return toast('No files in your archive yet.');
  const items=files.map(f=>({
    label:(f.name||'unnamed')+' · '+fmtSize(f.size),
    onclick:()=>{S.cpAtts.push({blobId:f.blobId,name:f.name,type:f.type,size:f.size});
      renderCpAtts();S.cpDirty=true;toast('Attached "'+f.name+'"')}
  }));
  showMenu(anchor,items);
}
function insertTemplate(t){
  const body=$('cp-body');
  body.focus();
  document.execCommand('insertHTML',false,t.html||'');
  S.cpDirty=true;
}
function saveCurrentAsTemplate(){
  const html=$('cp-body').innerHTML.trim();
  if(!html)return toast('Compose is empty — write something first.');
  const name=prompt('Template name','Template '+(SET.templates.length+1));if(!name)return;
  SET.templates.push({id:uid('t'),name,html});saveSettings();
  toast('Template saved');
}

/* ---------- profile ---------- */
function initials(name,email){
  const s=(name||email||'?').trim();
  const p=s.split(/[.\s@_-]+/).filter(Boolean);
  return ((p[0]||'?')[0]+(p[1]?p[1][0]:'')).toUpperCase();
}
function updateAccountAvatar(){
  const av=$('account-avatar');
  if(SET.photo){av.textContent='';av.style.backgroundImage=`url("${SET.photo}")`;av.classList.add('has-photo')}
  else{av.style.backgroundImage='';av.classList.remove('has-photo');av.textContent=initials(SET.displayName,S.user||'?')}
  const st=$('account-status');if(st)st.dataset.s=SET.statusKind||'none';
}
function openProfileMenu(){
  updateAccountAvatar();
  const pm=$('profile-menu');
  $('pm-hi').textContent='Hi'+(SET.displayName?', '+SET.displayName.split(' ')[0]:'');
  $('pm-email').textContent=S.user||'';
  const big=$('pm-big-avatar');
  if(SET.photo){big.textContent='';big.style.backgroundImage=`url("${SET.photo}")`;big.classList.add('has-photo')}
  else{big.textContent=initials(SET.displayName,S.user||'?');big.style.backgroundImage='';big.classList.remove('has-photo')}
  $('pm-dot').style.background=statusColor(SET.statusKind);
  $('pm-status-line').textContent=statusLabel(SET.statusKind,SET.statusText);
  const r=$('account-chip').getBoundingClientRect();
  pm.style.right=(innerWidth-r.right)+'px';pm.style.top=(r.bottom+8)+'px';
  pm.classList.remove('hidden');
}
function closeProfileMenu(){$('profile-menu').classList.add('hidden')}
const statusColor=k=>({here:'#22c55e',busy:'#ef4444',away:'#f59e0b',dnd:'#6366f1'}[k]||'transparent');
const statusLabel=(k,t)=>t?t:({here:'Available',busy:'Busy',away:'Away',dnd:'Do not disturb'}[k]||'No status');

function openProfile(){
  closeProfileMenu();
  const m=$('profile-modal');
  $('prof-photo-preview').textContent=SET.photo?'':initials(SET.displayName,S.user||'?');
  $('prof-photo-preview').style.backgroundImage=SET.photo?`url("${SET.photo}")`:'';
  $('prof-name').value=SET.displayName||S.identity&&S.identity.name||'';
  const pr=$('prof-pronouns'),prC=$('prof-pronouns-custom');
  const known=['','he/him','she/her','they/them'].includes(SET.pronouns);
  pr.value=known?SET.pronouns:'custom';
  prC.classList.toggle('hidden',pr.value!=='custom');
  prC.value=SET.pronounsCustom||'';
  document.querySelectorAll('#prof-status-grid .prof-stat').forEach(b=>b.classList.toggle('on',b.dataset.s===(SET.statusKind||'none')));
  $('prof-status-text').value=SET.statusText||'';
  fillTzSelect();$('prof-tz').value=SET.tz||'UTC';
  $('prof-sig').innerHTML=SET.sig||'';
  $('prof-sig-on').checked=!!SET.sigOn;
  $('prof-sig-reply').checked=!!SET.sigOnReply;
  m.classList.remove('hidden');
}
function fillTzSelect(){
  const s=$('prof-tz');if(s.options.length)return;
  const zones=['UTC','Europe/London','Europe/Berlin','Europe/Paris','Europe/Rome','Europe/Madrid','Europe/Amsterdam','Europe/Istanbul','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Toronto','America/Sao_Paulo','Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Bangkok','Asia/Singapore','Asia/Tokyo','Asia/Shanghai','Australia/Sydney','Pacific/Auckland'];
  const cur=SET.tz;if(cur&&!zones.includes(cur))zones.unshift(cur);
  for(const z of zones)s.add(new Option(z,z));
}
async function readImageAsDataURL(file,size,fit){
  return new Promise((res,rej)=>{
    const fr=new FileReader();
    fr.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const c=document.createElement('canvas');
        if(fit){
          const maxW=size||1920;
          const ratio=Math.min(1,maxW/img.width);
          c.width=Math.round(img.width*ratio);c.height=Math.round(img.height*ratio);
          c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        }else{
          const s=size||320;c.width=s;c.height=s;
          const r=Math.min(img.width,img.height);
          const sx=(img.width-r)/2,sy=(img.height-r)/2;
          c.getContext('2d').drawImage(img,sx,sy,r,r,0,0,s,s);
        }
        res(c.toDataURL('image/jpeg',0.82));
      };
      img.onerror=rej;img.src=fr.result;
    };
    fr.onerror=rej;fr.readAsDataURL(file);
  });
}
async function saveProfile(){
  const name=$('prof-name').value.trim();
  const pr=$('prof-pronouns').value;
  const prC=$('prof-pronouns-custom').value.trim();
  const st=document.querySelector('#prof-status-grid .prof-stat.on');
  SET.displayName=name;
  SET.pronouns=pr==='custom'?'custom':pr;
  SET.pronounsCustom=pr==='custom'?prC:'';
  SET.statusKind=st?st.dataset.s:'none';
  SET.statusText=$('prof-status-text').value.trim();
  SET.tz=$('prof-tz').value;
  SET.sig=$('prof-sig').innerHTML;
  SET.sigOn=$('prof-sig-on').checked;
  SET.sigOnReply=$('prof-sig-reply').checked;
  saveSettings();
  if(S.identity)await jmap([['Identity/set',{accountId:S.acct,
    update:{[S.identity.id]:{name:name||S.identity.name,htmlSignature:SET.sig,textSignature:$('prof-sig').innerText}}},'0']]).catch(()=>{});
  updateAccountAvatar();
  $('prof-status').textContent='Profile saved';
  setTimeout(()=>{$('prof-status').textContent='';$('profile-modal').classList.add('hidden')},1200);
}

/* tooltips + dot-rail live in vf-ui.js — delegate here */
const armTooltips=()=>VfUi.armTooltips();
const showTip=(el,t)=>VfUi.showTip(el,t);
const hideTip=()=>VfUi.hideTip();
const mountDotRail=el=>VfUi.mountDotRail(el);
function armDotRails(){
  document.querySelectorAll('.rows,.sp-body,.rail,.msgs,.modal-body,.sp-code,textarea.sp-area,.ai-body,.fv-main,.fv-side').forEach(mountDotRail);
}

/* ---------- AI side panel ---------- */
function armAiPanel(){
  const tab=$('ai-tab'),panel=$('ai-panel');
  let hoverT=null;
  const open=()=>{panel.classList.remove('hidden');paintAiPanel()};
  const close=()=>{if(SET.aiPinned)return;panel.classList.add('hidden')};
  tab.addEventListener('mouseenter',()=>{clearTimeout(hoverT);hoverT=setTimeout(open,180)});
  tab.addEventListener('click',()=>{
    if(panel.classList.contains('hidden'))open();else{SET.aiPinned=!SET.aiPinned;saveSettings();
      $('ai-pin').classList.toggle('on',SET.aiPinned)}
  });
  panel.addEventListener('mouseenter',()=>clearTimeout(hoverT));
  panel.addEventListener('mouseleave',()=>{hoverT=setTimeout(close,320)});
  $('ai-close').onclick=()=>{SET.aiPinned=false;saveSettings();$('ai-pin').classList.remove('on');panel.classList.add('hidden')};
  $('ai-pin').onclick=()=>{SET.aiPinned=!SET.aiPinned;saveSettings();$('ai-pin').classList.toggle('on',SET.aiPinned)};
  $('ai-refresh').onclick=paintAiPanel;
  $('ai-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&$('ai-input').value.trim())askAi($('ai-input').value.trim())});
  if(SET.aiPinned){$('ai-pin').classList.add('on');open()}
  updateAiTabBadge();
}
function updateAiTabBadge(){
  const n=todaysUnread().length;
  const b=$('ai-tab-badge');if(!b)return;
  b.textContent=n>99?'99+':(n||'');
  b.classList.toggle('hidden',!n);
}
function todaysUnread(){
  const start=Date.now()-24*3600e3;
  return S.list.filter(e=>!(e.keywords&&e.keywords.$seen)&&new Date(e.receivedAt).getTime()>start);
}
function todaysNew(){
  const start=Date.now()-24*3600e3;
  return S.list.filter(e=>new Date(e.receivedAt).getTime()>start);
}
function needsReply(){
  return S.list.filter(e=>{
    if(e.keywords&&e.keywords.$seen)return false;
    const s=((e.subject||'')+' '+(e.preview||'')).toLowerCase();
    return /\?/.test(s)||/\b(please|kindly|can you|could you|would you|let me know|by (?:tomorrow|monday|tuesday|wednesday|thursday|friday|end of|the end))/i.test(s);
  });
}
function topSenders(){
  const map={};
  for(const e of todaysNew()){const f=(e.from&&e.from[0]);if(!f)continue;const k=(f.name||f.email||'').split('<')[0].trim();map[k]=(map[k]||0)+1}
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,3);
}
function topTopics(){
  const stop=new Set(['the','a','and','for','to','of','in','on','with','is','are','from','your','my','re','fwd','this','that','be','was','have','has','you','i','it','at','as','an','by']);
  const map={};
  for(const e of todaysNew()){
    for(const w of ((e.subject||'')+' '+(e.preview||'')).toLowerCase().split(/[^a-z0-9']+/)){
      if(w.length<4||stop.has(w))continue;map[w]=(map[w]||0)+1;
    }
  }
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([w])=>w);
}
function extractActionItems(){
  const items=[];const seen=new Set();
  for(const e of todaysUnread().slice(0,10)){
    const src=(e.subject||'')+' — '+(e.preview||'');
    const sents=src.split(/(?<=[.?!])\s+/);
    for(const s of sents){
      const trim=s.trim();if(trim.length<12||trim.length>140)continue;
      if(!/\?|\b(please|kindly|can you|could you|by (?:tomorrow|monday|tuesday|wednesday|thursday|friday|end of))/i.test(trim))continue;
      const key=trim.toLowerCase().slice(0,60);if(seen.has(key))continue;seen.add(key);
      items.push({text:trim,from:(e.from&&e.from[0]&&(e.from[0].name||e.from[0].email))||'—',threadId:e.threadId,id:e.id});
      if(items.length>=5)break;
    }
    if(items.length>=5)break;
  }
  return items;
}
async function waitingForReply(){
  if(!S.byRole.sent)return[];
  const cutoff=Date.now()-48*3600e3;
  try{
    const rs=await jmap([
      ['Email/query',{accountId:S.acct,filter:{inMailbox:S.byRole.sent.id},limit:20,
        sort:[{property:'receivedAt',isAscending:false}]},'q'],
      ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},properties:['id','subject','to','threadId','receivedAt']},'e']]);
    const sent=(resp(rs,'Email/get').list||[]).filter(e=>new Date(e.receivedAt).getTime()<cutoff);
    if(!sent.length)return[];
    const tids=[...new Set(sent.map(e=>e.threadId))].slice(0,8);
    const tr=await jmap([['Thread/get',{accountId:S.acct,ids:tids},'0']]);
    const threads=resp(tr,'Thread/get').list||[];
    const waiting=[];
    for(const t of threads){
      const last=sent.find(x=>x.threadId===t.id);if(!last)continue;
      if(t.emailIds[t.emailIds.length-1]===last.id)waiting.push({sent:last,thread:t});
    }
    return waiting.slice(0,4);
  }catch(_){return[]}
}
function suggestedReplies(e){
  const s=((e.subject||'')+' '+(e.preview||'')).toLowerCase();
  const set=[];
  if(/\?/.test(s))set.push({label:'Answer briefly',text:'Thanks for the note — here\'s the quick answer:\n\n'});
  if(/\b(schedule|meeting|call|available|free|time)\b/.test(s))set.push({label:'Propose a time',text:'Happy to jump on a call. Would '+niceHour()+' work for you?'});
  if(/\b(thanks|thank you|appreciate|great)\b/.test(s))set.push({label:'Thanks back',text:'Thanks — appreciate you flagging that.'});
  if(/\b(invoice|payment|receipt|billed?)\b/.test(s))set.push({label:'Acknowledge invoice',text:'Received — I\'ll process this and confirm once paid.'});
  set.push({label:'Sounds good',text:'Sounds good — will follow up on this shortly.'});
  set.push({label:'Need more time',text:'Thanks — I need a bit more time on this. I\'ll get back to you by end of day.'});
  return set.slice(0,3);
}
function niceHour(){const d=new Date();d.setHours(d.getHours()+2,0,0,0);return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' today'}

function paintAiPanel(){
  const body=$('ai-body');body.innerHTML='';
  const newMail=todaysNew(),unread=todaysUnread(),need=needsReply();
  /* today card */
  const today=document.createElement('div');today.className='ai-card ai-today';
  today.innerHTML=`
    <div class="ai-stats">
      <div><b>${newMail.length}</b><span>new today</span></div>
      <div><b>${unread.length}</b><span>unread</span></div>
      <div><b>${need.length}</b><span>need reply</span></div>
    </div>`;
  body.appendChild(today);

  /* daily brief */
  const brief=document.createElement('div');brief.className='ai-card';
  const senders=topSenders(),topics=topTopics();
  let b='';
  if(!newMail.length)b='Quiet inbox — nothing new in the last 24 hours.';
  else{
    const sTxt=senders.length?senders.map(([n,c])=>`<b>${esc(n)}</b> (${c})`).join(', '):'various senders';
    const tTxt=topics.length?`Topics: ${topics.slice(0,4).map(esc).join(' · ')}.`:'';
    const nTxt=need.length?` <span class="ai-hot">${need.length} thread${need.length===1?'':'s'} probably need your reply.</span>`:'';
    b=`You got <b>${newMail.length}</b> mail${newMail.length===1?'':'s'} today from ${sTxt}. ${tTxt}${nTxt}`;
  }
  brief.innerHTML=`<div class="ai-h">Brief</div><div class="ai-p">${b}</div>`;
  body.appendChild(brief);

  /* suggested replies */
  if(need.length){
    const sr=document.createElement('div');sr.className='ai-card';
    sr.innerHTML=`<div class="ai-h">Suggested replies</div>`;
    for(const e of need.slice(0,3)){
      const row=document.createElement('div');row.className='ai-sr-row';
      const who=(e.from&&e.from[0]&&(e.from[0].name||e.from[0].email))||'—';
      const subj=e.subject||'(no subject)';
      row.innerHTML=`<div class="ai-sr-sub"><span class="ai-sr-who">${esc(who)}</span> · ${esc(subj.slice(0,60))}</div>`;
      const chips=document.createElement('div');chips.className='ai-sr-chips';
      for(const rep of suggestedReplies(e)){
        const b=document.createElement('button');b.className='ai-chip';b.textContent=rep.label;
        b.onclick=()=>replyWithText(e,rep.text);
        chips.appendChild(b);
      }
      row.appendChild(chips);sr.appendChild(row);
    }
    body.appendChild(sr);
  }

  /* action items */
  const actions=extractActionItems();
  if(actions.length){
    const ac=document.createElement('div');ac.className='ai-card';
    ac.innerHTML=`<div class="ai-h">Action items</div>`;
    const list=document.createElement('ul');list.className='ai-list';
    for(const a of actions){
      const li=document.createElement('li');
      li.innerHTML=`<span>${esc(a.text)}</span><small>— ${esc(a.from)}</small>`;
      li.onclick=()=>{const e=S.emailCache[a.id];if(e)openThread(a.threadId).catch(err)};
      list.appendChild(li);
    }
    ac.appendChild(list);body.appendChild(ac);
  }

  /* waiting for reply — async */
  const wfr=document.createElement('div');wfr.className='ai-card';
  wfr.innerHTML=`<div class="ai-h">Waiting for reply</div><div class="ai-p ai-mute">Scanning your Sent…</div>`;
  body.appendChild(wfr);
  waitingForReply().then(list=>{
    if(!list.length){wfr.querySelector('.ai-p').textContent='Nothing waiting. Nice.';return}
    wfr.querySelector('.ai-p').remove();
    const ul=document.createElement('ul');ul.className='ai-list';
    for(const w of list){
      const ago=Math.round((Date.now()-new Date(w.sent.receivedAt))/3600e3);
      const to=(w.sent.to&&w.sent.to[0]&&(w.sent.to[0].name||w.sent.to[0].email))||'—';
      const li=document.createElement('li');
      li.innerHTML=`<span>${esc(w.sent.subject||'(no subject)')}</span><small>${esc(to)} · ${ago}h ago</small>`;
      const nudge=document.createElement('button');nudge.className='ai-chip';nudge.textContent='Nudge';
      nudge.onclick=e=>{e.stopPropagation();nudgeThread(w)};
      li.appendChild(nudge);
      li.onclick=()=>openThread(w.thread.id).catch(err);
      ul.appendChild(li);
    }
    wfr.appendChild(ul);
  });

  /* focus mode */
  const fm=document.createElement('div');fm.className='ai-card';
  const focusOn=SET.focusUntil&&SET.focusUntil>Date.now();
  const mins=focusOn?Math.max(1,Math.round((SET.focusUntil-Date.now())/60000)):25;
  fm.innerHTML=`<div class="ai-h">Focus mode</div>
    <div class="ai-p ai-mute">Mutes notifications and pauses live refresh.</div>
    <div class="ai-focus-row">
      <button class="ai-chip ${focusOn?'ai-chip-on':''}" id="ai-focus-btn">${focusOn?`On · ${mins}m left`:'Start 25 min'}</button>
      ${focusOn?'<button class="ai-chip" id="ai-focus-stop">Stop</button>':''}
    </div>`;
  fm.querySelector('#ai-focus-btn').onclick=()=>{
    if(focusOn){SET.focusUntil=0;saveSettings();paintAiPanel();return}
    SET.focusUntil=Date.now()+25*60000;saveSettings();paintAiPanel();
    toast('Focus mode on — 25 minutes');
  };
  const stop=fm.querySelector('#ai-focus-stop');if(stop)stop.onclick=()=>{SET.focusUntil=0;saveSettings();paintAiPanel()};
  body.appendChild(fm);

  mountDotRail(body);
  updateAiTabBadge();
}
function replyWithText(e,text){
  openCompose('reply',e);
  setTimeout(()=>{
    const body=$('cp-body');
    body.innerHTML='<div>'+esc(text).replace(/\n/g,'<br>')+'</div><br>'+body.innerHTML;
    S.cpDirty=true;
  },80);
}
async function nudgeThread(w){
  const rs=await jmap([['Email/get',{accountId:S.acct,ids:[w.sent.id],
    properties:LIST_PROPS.concat(['cc','bodyValues','textBody','htmlBody','messageId','references']),
    fetchHTMLBodyValues:true,fetchTextBodyValues:true,maxBodyValueBytes:200000},'0']]);
  const e=(resp(rs,'Email/get').list||[])[0];if(!e)return;
  openCompose('reply',Object.assign({},e,{from:e.to,to:[{email:S.user}]}));
  setTimeout(()=>{
    $('cp-subject').value=/^Re:/i.test(e.subject||'')?e.subject:'Re: '+(e.subject||'');
    $('cp-to').value=(e.to||[]).map(p=>p.email).join(', ');
    $('cp-body').innerHTML='<div>Just floating this back to the top — did you get a chance to look?</div><br>'+$('cp-body').innerHTML;
    S.cpDirty=true;
  },80);
}
async function runSummarize(){
  const btn=$('tb-summarize');
  btn.classList.add('summarizing');
  SET.aiPinned=true;saveSettings();
  $('ai-pin').classList.add('on');
  $('ai-panel').classList.remove('hidden');
  const body=$('ai-body');body.innerHTML='<div class="ai-shimmer"><div></div><div></div><div></div><div></div></div>';
  /* fetch fresh sent list into cache for waiting-for-reply, and yield a beat so the glow reads */
  const t=Date.now();
  await new Promise(r=>setTimeout(r,850));
  paintAiPanel();
  const spent=Date.now()-t;
  await new Promise(r=>setTimeout(r,Math.max(0,1200-spent)));
  btn.classList.remove('summarizing');
  toast('Brief ready');
}
function askAi(q){
  const s=$('ai-status');s.textContent='"'+q.slice(0,80)+'" — AI is offline. Once we wire an LLM this becomes a real inbox chat.';
  $('ai-input').value='';
}
function focusActive(){return SET.focusUntil&&SET.focusUntil>Date.now()}

/* ---------- files drawer ---------- */
const FILE_TYPES=[
  {key:'all',label:'All files',match:()=>true,hue:220},
  {key:'image',label:'Images',match:f=>/^image\//.test(f.type),hue:32},
  {key:'pdf',label:'PDFs',match:f=>f.type==='application/pdf'||/\.pdf$/i.test(f.name||''),hue:0},
  {key:'doc',label:'Documents',match:f=>/msword|wordprocessing|officedocument\.word|opendocument\.text/.test(f.type)||/\.(docx?|odt|rtf|txt|md)$/i.test(f.name||''),hue:210},
  {key:'sheet',label:'Spreadsheets',match:f=>/excel|spreadsheet|ms-excel|opendocument\.spreadsheet/.test(f.type)||/\.(xlsx?|ods|csv|tsv)$/i.test(f.name||''),hue:145},
  {key:'slide',label:'Presentations',match:f=>/powerpoint|presentation|opendocument\.presentation/.test(f.type)||/\.(pptx?|odp|key)$/i.test(f.name||''),hue:20},
  {key:'video',label:'Video',match:f=>/^video\//.test(f.type)||/\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(f.name||''),hue:280},
  {key:'audio',label:'Audio',match:f=>/^audio\//.test(f.type)||/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name||''),hue:305},
  {key:'archive',label:'Archives',match:f=>/(zip|rar|7z|tar|gzip|compressed)/.test(f.type)||/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i.test(f.name||''),hue:180},
  {key:'other',label:'Other',match:f=>false,hue:0} /* fallback: nothing else matched */
];
function fileTypeKey(f){
  for(const t of FILE_TYPES){if(t.key==='all'||t.key==='other')continue;if(t.match(f))return t.key}
  return 'other';
}
function fileIcon(k){
  const paths={
    image:'M4 4h16v16H4zM8 12l3 3 3-4 5 5M8.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
    pdf:'M6 3h9l4 4v14H6zM15 3v5h4M9 12h6M9 16h4M9 8h1',
    doc:'M6 3h9l4 4v14H6zM15 3v5h4M9 10h7M9 14h7M9 18h5',
    sheet:'M6 3h12v18H6zM6 8h12M6 13h12M6 18h12M11 3v18M15 3v18',
    slide:'M4 5h16v11H4zM12 16v4M8 20h8',
    video:'M4 5h13v14H4zM17 8l4-2v12l-4-2z',
    audio:'M9 18V6l12-3v12M9 18a3 3 0 1 1-3-3M21 15a3 3 0 1 1-3-3',
    archive:'M4 6h16v3H4zM6 9v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M10 13h4',
    other:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'
  };
  return paths[k]||paths.other;
}
async function detectFileFlags(f){
  const nm=(f.name||'').toLowerCase();
  const sender=((f.from&&f.from.email)||'').toLowerCase();
  const sub=(f.subject||'').toLowerCase();
  const flags=[];
  if(/(^|[-_ ])(invoice|receipt|bill|rechnung|facture|factura)/.test(nm)||
     /(invoice|receipt|payment due|amount due|bill)/.test(sub))flags.push({key:'invoice',label:'Invoice',hue:20});
  if(/docusign|hellosign|adobesign|e[- ]?sign|signature[-_ ]?requested/.test(nm)||
     /docusign\.net|hellosign\.com|adobesign\.com|adobe\.com/.test(sender)||
     /sign(ed|ature)? (this|attached|required|please)/.test(sub))flags.push({key:'sign',label:'Sign',hue:280});
  if(/^report|weekly|monthly|quarterly|q[1-4]|kpi/.test(nm))flags.push({key:'report',label:'Report',hue:210});
  if(/contract|agreement|nda|mou|terms/.test(nm))flags.push({key:'contract',label:'Contract',hue:145});
  return flags;
}
function computeGroups(files){
  /* group by normalized name+size for dupe/version stacks */
  const map={};
  for(const f of files){
    const norm=(f.name||'').toLowerCase().replace(/\s*\(?v?\d+\)?\.?/g,'.').replace(/[_-]/g,' ').trim();
    const key=norm+'::'+f.size;
    (map[key]=map[key]||[]).push(f);
  }
  const dupeKeys=new Set(),versionKeys=new Set();
  for(const [k,arr] of Object.entries(map)){
    if(arr.length<2)continue;
    /* if all same size same name → dupes; if same normalized name but names vary or sizes differ → versions */
    const sameName=arr.every(x=>x.name===arr[0].name);
    const sameSize=arr.every(x=>x.size===arr[0].size);
    if(sameName&&sameSize)dupeKeys.add(k);else versionKeys.add(k);
  }
  return{map,dupeKeys,versionKeys};
}
function fileGroupKey(f){
  const norm=(f.name||'').toLowerCase().replace(/\s*\(?v?\d+\)?\.?/g,'.').replace(/[_-]/g,' ').trim();
  return norm+'::'+f.size;
}
async function ensureFilesIndex(force){
  if(!force&&S.filesIndex&&Date.now()-(S.filesIndexAt||0)<60000)return S.filesIndex;
  S.filesLoading=true;
  paintFilesLoading();
  const rs=await jmap([
    ['Email/query',{accountId:S.acct,filter:{hasAttachment:true},limit:500,
      sort:[{property:'receivedAt',isAscending:false}]},'q'],
    ['Email/get',{accountId:S.acct,'#ids':{resultOf:'q',name:'Email/query',path:'/ids'},
      properties:['id','threadId','subject','from','receivedAt','attachments']},'e']]);
  const emails=resp(rs,'Email/get').list||[];
  const files=[];
  for(const e of emails){
    for(const a of (e.attachments||[])){
      if(!a.blobId)continue;
      if(a.disposition==='inline'&&a.cid)continue;
      const f={
        blobId:a.blobId,name:a.name||'unnamed',size:a.size||0,type:a.type||'',
        emailId:e.id,threadId:e.threadId,subject:e.subject||'',
        receivedAt:e.receivedAt,from:(e.from&&e.from[0])||{},
      };
      f.kind=fileTypeKey(f);
      f.flags=detectFileFlags(f);
      files.push(f);
    }
  }
  S.filesIndex=files;S.filesIndexAt=Date.now();S.filesLoading=false;
  const g=computeGroups(files);S.filesGroups=g;
  return files;
}
function showFiles(){
  $('list-view').classList.add('hidden');
  $('thread-view').classList.add('hidden');
  $('files-view').classList.remove('hidden');
  showFilesTab();
  $('fv-sort').value=SET.filesSort;
  paintFilesTypes();paintFilesCollections();paintFolderTree();paintFilesFlags();paintFilesContacts();paintFilesDupesSection();
  ensureFilesIndex().then(()=>{paintFilesTypes();paintFolderTree();paintFilesFlags();paintFilesContacts();paintFilesDupesSection();paintFilesMain()}).catch(e=>{console.error('files paint fail',e);$('fv-main').textContent='Could not load files: '+(e&&e.message||e)});
}
function hideFiles(){$('files-view').classList.add('hidden')}
function paintFilesLoading(){
  const m=$('fv-main');if(!m)return;
  m.innerHTML='<div class="ai-shimmer"><div></div><div></div><div></div><div></div></div>';
}
/* ============================================================
   Files: Explorer toolkit
   ============================================================ */

/* ---- display helpers ---- */
function displayName(f){
  const meta=(SET.fileMeta||{})[f.blobId]||{};
  let n=meta.displayName||f.name||'unnamed';
  if(SET.filesHideExt){const p=n.split('.');if(p.length>1)n=p.slice(0,-1).join('.')}
  return n;
}
function iconSizePx(){return{xs:60,sm:72,md:96,lg:128,xl:172}[SET.filesIconSize]||96}

/* ---- bin ---- */
function isBinned(id){return !!((SET.filesBin||{})[id]||(SET.foldersBin||{})[id])}
function binFile(f){
  SET.filesBin=SET.filesBin||{};
  SET.filesBin[f.blobId]={name:f.name,size:f.size,type:f.type,deletedAt:Date.now(),originalFolder:(SET.fileFolders||{})[f.blobId]||''};
  saveSettings();
}
function unbinFile(blobId){
  const rec=(SET.filesBin||{})[blobId];if(!rec)return;
  if(rec.originalFolder){SET.fileFolders=SET.fileFolders||{};SET.fileFolders[blobId]=rec.originalFolder}
  delete SET.filesBin[blobId];saveSettings();
}
function binFolder(id){
  SET.foldersBin=SET.foldersBin||{};
  const f=folderById(id);if(!f)return;
  SET.foldersBin[id]={name:f.name,parentId:f.parentId,deletedAt:Date.now()};
  SET.folders=SET.folders.filter(x=>x.id!==id);
  saveSettings();
}
function unbinFolder(id){
  const rec=(SET.foldersBin||{})[id];if(!rec)return;
  SET.folders=SET.folders||[];SET.folders.push({id,name:rec.name,parentId:rec.parentId,createdAt:Date.now()});
  delete SET.foldersBin[id];saveSettings();
}
function emptyBin(){
  if(!confirm('Empty the Recycle Bin? This clears the deleted list. Original mail is untouched.'))return;
  SET.filesBin={};SET.foldersBin={};saveSettings();paintFilesMain();paintFolderTree();toast('Bin emptied');
}

/* ---- selection ---- */
function selKey(item){return (item.kind||'f')+':'+item.id}
function clearSel(){S.filesSel.clear();S.filesFocus=null}
function selectOnly(item){S.filesSel=new Set([selKey(item)]);S.filesFocus=selKey(item)}
function toggleSel(item){
  const k=selKey(item);
  if(S.filesSel.has(k))S.filesSel.delete(k);else S.filesSel.add(k);
  S.filesFocus=k;
}
function rangeSelect(items,startKey,endKey){
  let inRange=false;
  for(const it of items){
    const k=selKey(it);
    if(k===startKey||k===endKey){S.filesSel.add(k);inRange=!inRange;if(!inRange)break;continue}
    if(inRange)S.filesSel.add(k);
  }
}
function currentViewItems(){
  /* what's showing in the main grid (folders + files, in order) */
  const inSmart=/^__/.test(SET.filesActive||'')||(SET.filesActive&&(SET.fileCollections||[]).find(x=>x.id===SET.filesActive));
  const items=[];
  if(!inSmart&&SET.filesActive!=='__bin'){
    for(const fd of folderChildren(SET.currentFolder||''))items.push({kind:'folder',id:fd.id,ref:fd});
  }
  if(SET.filesActive==='__bin'){
    for(const id of Object.keys(SET.foldersBin||{}))items.push({kind:'folder',id,ref:{id,name:SET.foldersBin[id].name,parentId:SET.foldersBin[id].parentId},binned:true});
    for(const bid of Object.keys(SET.filesBin||{})){
      const rec=SET.filesBin[bid];
      items.push({kind:'file',id:bid,ref:{blobId:bid,name:rec.name,size:rec.size,type:rec.type,receivedAt:rec.deletedAt,from:{name:'—'},kind:fileTypeKey({name:rec.name,type:rec.type})},binned:true});
    }
    return items;
  }
  for(const f of currentFileSet()){
    if(isBinned(f.blobId))continue;
    items.push({kind:'file',id:f.blobId,ref:f});
  }
  return items;
}

/* ---- clipboard + undo ---- */
function copySelection(op){
  const items=currentViewItems().filter(it=>S.filesSel.has(selKey(it)));
  if(!items.length)return toast('Select something first');
  S.filesClipboard={op,items,fromFolder:SET.currentFolder||''};
  paintFilesMain();
  toast((op==='cut'?'Cut ':'Copy ')+items.length+' item'+(items.length===1?'':'s'));
}
function pasteHere(){
  const cb=S.filesClipboard;if(!cb||!cb.items.length)return;
  const target=SET.currentFolder||'';
  const before=JSON.parse(JSON.stringify({fileFolders:SET.fileFolders||{},folders:SET.folders||[]}));
  for(const it of cb.items){
    if(it.kind==='file'){
      if(cb.op==='cut'){moveFileToFolder(it.id,target)}
      else{/* copy — reference-based: reassign blob but keep in original too via virtual copy meta */
        /* proper "Copy of" — since blobs are content-addressed we CAN put same blob in a different folder */
        /* but Windows would create a new file. Here we make a "virtual copy" via a meta record */
        SET.fileMeta=SET.fileMeta||{};
        const cpKey='copy:'+it.id+':'+uid('c');
        SET.fileFolders=SET.fileFolders||{};SET.fileFolders[cpKey]=target;
        SET.fileMeta[cpKey]=Object.assign({},SET.fileMeta[it.id]||{},{displayName:'Copy of '+(SET.fileMeta[it.id]&&SET.fileMeta[it.id].displayName||it.ref.name)});
        /* register into filesIndex as a shallow duplicate ref */
        (S.filesIndex=S.filesIndex||[]).push(Object.assign({},it.ref,{blobId:cpKey,_copyOf:it.id,name:'Copy of '+(it.ref.name||'')}));
      }
    }else{
      if(cb.op==='cut'){const fd=folderById(it.id);if(fd)fd.parentId=target;saveSettings()}
    }
  }
  pushUndo({label:'Paste',before});
  S.filesClipboard=cb.op==='cut'?null:cb; /* copy stays; cut clears */
  clearSel();paintFolderTree();paintFilesMain();
  toast('Pasted');
}
function pushUndo(op){
  S.filesUndo=S.filesUndo||[];S.filesUndo.push(op);
  if(S.filesUndo.length>50)S.filesUndo.shift();
}
function doUndo(){
  const op=S.filesUndo&&S.filesUndo.pop();if(!op)return toast('Nothing to undo');
  if(op.before){
    if(op.before.fileFolders)SET.fileFolders=op.before.fileFolders;
    if(op.before.folders)SET.folders=op.before.folders;
    if(op.before.filesBin)SET.filesBin=op.before.filesBin;
    if(op.before.foldersBin)SET.foldersBin=op.before.foldersBin;
    saveSettings();
  }
  clearSel();paintFolderTree();paintFilesMain();
  toast('Undone: '+op.label);
}

/* ---- history nav ---- */
function pushHistory(id){
  if(S.filesHistory[S.filesHistoryPos]===id)return;
  S.filesHistory=S.filesHistory.slice(0,S.filesHistoryPos+1);
  S.filesHistory.push(id);S.filesHistoryPos=S.filesHistory.length-1;
}
function historyBack(){if(S.filesHistoryPos>0){S.filesHistoryPos--;SET.currentFolder=S.filesHistory[S.filesHistoryPos];clearSel();paintFilesMain();paintFolderTree()}}
function historyForward(){if(S.filesHistoryPos<S.filesHistory.length-1){S.filesHistoryPos++;SET.currentFolder=S.filesHistory[S.filesHistoryPos];clearSel();paintFilesMain();paintFolderTree()}}
function historyUp(){const f=folderById(SET.currentFolder);const p=f?f.parentId||'':'';SET.currentFolder=p;pushHistory(p);clearSel();paintFilesMain();paintFolderTree()}

/* ---- inline rename ---- */
function beginRename(item,cell){
  S.filesRenaming=selKey(item);
  const nameEl=cell.querySelector('.fv-cell-name');if(!nameEl)return;
  const cur=item.kind==='folder'?item.ref.name:displayName(item.ref);
  const inp=document.createElement('input');inp.type='text';inp.value=cur;inp.className='fv-rename';
  nameEl.replaceWith(inp);inp.focus();inp.select();
  const commit=()=>{
    const v=inp.value.trim();if(!v){cancel();return}
    if(item.kind==='folder'){item.ref.name=v;saveSettings()}
    else{SET.fileMeta=SET.fileMeta||{};SET.fileMeta[item.id]=SET.fileMeta[item.id]||{};SET.fileMeta[item.id].displayName=v;saveSettings()}
    S.filesRenaming=null;paintFilesMain();paintFolderTree();
  };
  const cancel=()=>{S.filesRenaming=null;paintFilesMain()};
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit()}else if(e.key==='Escape'){e.preventDefault();cancel()}};
  inp.onblur=commit;
}

/* ---- zip export ---- */
async function loadJSZip(){
  if(window.JSZip)return window.JSZip;
  await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)});
  return window.JSZip;
}
async function zipSelection(){
  const items=currentViewItems().filter(it=>it.kind==='file'&&S.filesSel.has(selKey(it)));
  if(!items.length)return toast('Select some files first');
  toast('Compressing '+items.length+' file'+(items.length===1?'':'s')+'…');
  const JSZip=await loadJSZip();
  const zip=new JSZip();
  for(const it of items){
    try{const r=await fetch(downloadUrl(it.ref.blobId,it.ref.name),{headers:{Authorization:'Basic '+S.token}});
      const buf=await r.arrayBuffer();
      zip.file(displayName(it.ref),buf);
    }catch(e){err(e)}
  }
  const blob=await zip.generateAsync({type:'blob'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='vfmail-'+Date.now()+'.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast('Zip downloaded');
}

/* ---- send-to mail recipient ---- */
async function sendSelectionByMail(){
  const items=currentViewItems().filter(it=>it.kind==='file'&&S.filesSel.has(selKey(it)));
  if(!items.length)return toast('Select some files first');
  openCompose();
  await sleep(60);
  for(const it of items)S.cpAtts.push({blobId:it.ref.blobId,name:displayName(it.ref),type:it.ref.type,size:it.ref.size});
  renderCpAtts();S.cpDirty=true;
  toast('Attached '+items.length+' file'+(items.length===1?'':'s')+' — pick a recipient');
}

/* folders engine */
function folderById(id){return (SET.folders||[]).find(f=>f.id===id)}
function folderChildren(parentId){return (SET.folders||[]).filter(f=>(f.parentId||'')===(parentId||''))}
function folderPath(id){
  const chain=[];let cur=folderById(id),g=0;
  while(cur&&g++<20){chain.unshift(cur);cur=folderById(cur.parentId)}
  return chain;
}
function folderItemCount(id){
  let n=0;
  for(const bid of Object.keys(SET.fileFolders||{}))if(SET.fileFolders[bid]===id)n++;
  n+=folderChildren(id).length;
  return n;
}
function createFolder(parentId){
  const name=prompt('New folder name');if(!name)return null;
  const f={id:uid('fd'),name:name.trim(),parentId:parentId||'',createdAt:Date.now()};
  (SET.folders=SET.folders||[]).push(f);saveSettings();
  return f;
}
function renameFolder(id){
  const f=folderById(id);if(!f)return;
  const n=prompt('Rename folder',f.name);if(!n)return;
  f.name=n.trim();saveSettings();
}
function deleteFolder(id){
  const f=folderById(id);if(!f)return;
  const kids=folderChildren(id);
  if(kids.length){toast('Delete subfolders first.');return}
  if(!confirm('Delete folder "'+f.name+'"? Files inside go back to root.'))return;
  /* release files back to root */
  for(const bid of Object.keys(SET.fileFolders||{}))if(SET.fileFolders[bid]===id)delete SET.fileFolders[bid];
  SET.folders=SET.folders.filter(x=>x.id!==id);
  if(SET.currentFolder===id)SET.currentFolder=f.parentId||'';
  saveSettings();
}
function moveFileToFolder(blobId,folderId){
  SET.fileFolders=SET.fileFolders||{};
  if(folderId)SET.fileFolders[blobId]=folderId;else delete SET.fileFolders[blobId];
  saveSettings();
}
function enterFolder(id){SET.currentFolder=id||'';saveSettings();pushHistory(id||'');clearSel();paintFilesMain();paintFolderTree()}

function paintBreadcrumb(){
  const wrap=$('fv-crumbs');if(!wrap)return;
  wrap.innerHTML='';
  const home=document.createElement('button');home.className='fv-crumb'+(SET.currentFolder?'':' on');
  home.innerHTML='<svg viewBox="0 0 24 24"><path d="M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg><span>Files</span>';
  home.onclick=()=>enterFolder('');
  home.ondragover=e=>{e.preventDefault();home.classList.add('fv-drop')};
  home.ondragleave=()=>home.classList.remove('fv-drop');
  home.ondrop=e=>{e.preventDefault();home.classList.remove('fv-drop');const b=e.dataTransfer.getData('vfblob');if(b){moveFileToFolder(b,'');paintFilesMain();toast('Moved to root')}};
  wrap.appendChild(home);
  for(const f of folderPath(SET.currentFolder)){
    const sep=document.createElement('span');sep.className='fv-crumb-sep';sep.textContent='›';wrap.appendChild(sep);
    const b=document.createElement('button');b.className='fv-crumb'+(f.id===SET.currentFolder?' on':'');
    b.innerHTML='<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>'+VfUi.esc(f.name)+'</span>';
    b.onclick=()=>enterFolder(f.id);
    b.ondragover=e=>{e.preventDefault();b.classList.add('fv-drop')};
    b.ondragleave=()=>b.classList.remove('fv-drop');
    b.ondrop=e=>{e.preventDefault();b.classList.remove('fv-drop');const bl=e.dataTransfer.getData('vfblob');if(bl){moveFileToFolder(bl,f.id);paintFilesMain();toast('Moved to '+f.name)}};
    wrap.appendChild(b);
  }
}

function paintFilesTypes(){
  const wrap=$('fv-types');wrap.innerHTML='';
  const counts={};for(const f of (S.filesIndex||[]))counts[f.kind]=(counts[f.kind]||0)+1;
  counts.all=(S.filesIndex||[]).length;
  for(const t of FILE_TYPES){
    if(t.key==='other'&&!counts.other)continue;
    const b=document.createElement('button');b.className='fv-type-chip'+(SET.filesFilter===t.key?' on':'');
    b.innerHTML=`<span class="fv-type-dot" style="background:hsl(${t.hue} 62% 52%)"></span>
      <span class="fv-type-l">${esc(t.label)}</span>
      <span class="fv-type-n">${counts[t.key]||0}</span>`;
    b.onclick=()=>{SET.filesFilter=t.key;SET.filesActive='';paintFilesTypes();paintFilesCollections();paintFilesMain()};
    wrap.appendChild(b);
  }
}
function paintFolderTree(){
  const wrap=$('fv-folders');if(!wrap)return;wrap.innerHTML='';
  function paint(parentId,depth){
    for(const fd of folderChildren(parentId).sort((a,b)=>a.name.localeCompare(b.name))){
      const b=document.createElement('button');b.className='fv-col-item fv-folder-row'+(SET.currentFolder===fd.id?' on':'');
      b.style.paddingLeft=(10+depth*14)+'px';
      b.innerHTML=`<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span>${VfUi.esc(fd.name)}</span><span class="fv-col-n">${folderItemCount(fd.id)}</span>`;
      b.onclick=()=>{SET.filesActive='';enterFolder(fd.id);paintFilesTypes();paintFilesCollections();paintFolderTree();paintFilesFlags();paintFilesContacts()};
      b.oncontextmenu=e=>{e.preventDefault();folderContextMenu(fd,b,e)};
      b.ondragover=e=>{e.preventDefault();b.classList.add('fv-drop')};
      b.ondragleave=()=>b.classList.remove('fv-drop');
      b.ondrop=e=>{e.preventDefault();b.classList.remove('fv-drop');const bl=e.dataTransfer.getData('vfblob');if(bl){moveFileToFolder(bl,fd.id);paintFolderTree();paintFilesMain();toast('Moved to '+fd.name)}};
      wrap.appendChild(b);
      paint(fd.id,depth+1);
    }
  }
  paint('',0);
  if(!wrap.children.length){wrap.innerHTML='<div class="fv-side-empty">No folders yet</div>'}
  const add=document.createElement('button');add.className='btn-ghost fv-add-col';add.textContent='+ New folder';
  add.onclick=()=>{if(createFolder(SET.currentFolder||''))paintFolderTree(),paintFilesMain()};
  wrap.appendChild(add);
}
function paintFilesContacts(){
  const wrap=$('fv-contacts');if(!wrap)return;
  wrap.innerHTML='';
  const map={};
  for(const f of (S.filesIndex||[])){
    const k=(f.from.email||f.from.name||'—');
    map[k]=(map[k]||{n:0,name:f.from.name||f.from.email,email:f.from.email});
    map[k].n++;
  }
  const list=Object.entries(map).sort((a,b)=>b[1].n-a[1].n).slice(0,10);
  if(!list.length){wrap.innerHTML='<div class="fv-side-empty">No senders yet</div>';return}
  for(const [k,v] of list){
    const b=document.createElement('button');b.className='fv-col-item'+(SET.filesActive==='__contact:'+k?' on':'');
    b.innerHTML=`<span class="fv-contact-av" style="background:hsl(${VfUi.hueFor(k)} 62% 60%)">${VfUi.esc((v.name||v.email||'?')[0].toUpperCase())}</span>
      <span>${VfUi.esc(v.name||v.email)}</span><span class="fv-col-n">${v.n}</span>`;
    b.onclick=()=>{SET.filesActive=SET.filesActive==='__contact:'+k?'':'__contact:'+k;SET.filesFilter='all';paintFilesTypes();paintFilesCollections();paintFilesContacts();paintFilesMain()};
    wrap.appendChild(b);
  }
}
function paintFilesFlags(){
  const wrap=$('fv-flags');if(!wrap)return;wrap.innerHTML='';
  const counts={invoice:0,sign:0,report:0,contract:0};
  for(const f of (S.filesIndex||[])){
    const arr=Array.isArray(f.flags)?f.flags:[];
    for(const fl of arr)counts[fl.key]=(counts[fl.key]||0)+1;
  }
  const defs=[
    {key:'invoice',label:'Invoices',hue:20},
    {key:'sign',label:'To sign',hue:280},
    {key:'report',label:'Reports',hue:210},
    {key:'contract',label:'Contracts',hue:145}
  ];
  for(const d of defs){
    if(!counts[d.key])continue;
    const b=document.createElement('button');b.className='fv-col-item'+(SET.filesActive==='__flag:'+d.key?' on':'');
    b.innerHTML=`<span class="fv-flag-dot" style="background:hsl(${d.hue} 62% 52%)"></span>
      <span>${d.label}</span><span class="fv-col-n">${counts[d.key]}</span>`;
    b.onclick=()=>{SET.filesActive=SET.filesActive==='__flag:'+d.key?'':'__flag:'+d.key;SET.filesFilter='all';paintFilesTypes();paintFilesCollections();paintFilesFlags();paintFilesContacts();paintFilesMain()};
    wrap.appendChild(b);
  }
}
function paintFilesCollections(){
  const wrap=$('fv-cols');wrap.innerHTML='';
  const starN=Object.keys(SET.starredFiles||{}).length;
  const star=document.createElement('button');star.className='fv-col-item'+(SET.filesActive==='__starred'?' on':'');
  star.innerHTML=`<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z"/></svg><span>Starred</span><span class="fv-col-n">${starN}</span>`;
  star.onclick=()=>{SET.filesActive=SET.filesActive==='__starred'?'':'__starred';SET.filesFilter='all';paintFilesTypes();paintFilesCollections();paintFilesMain()};
  wrap.appendChild(star);
  for(const c of (SET.fileCollections||[])){
    const b=document.createElement('button');b.className='fv-col-item'+(SET.filesActive===c.id?' on':'');
    b.innerHTML=`<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span>${esc(c.name)}</span><span class="fv-col-n">${(c.blobIds||[]).length}</span>`;
    b.onclick=()=>{SET.filesActive=SET.filesActive===c.id?'':c.id;SET.filesFilter='all';paintFilesTypes();paintFilesCollections();paintFilesMain()};
    b.oncontextmenu=e=>{e.preventDefault();showMenu(b,[
      {label:'Rename',onclick:()=>{const n=prompt('Rename collection',c.name);if(!n)return;c.name=n;saveSettings();paintFilesCollections()}},
      {label:'Delete',onclick:()=>{if(!confirm('Delete collection "'+c.name+'"?'))return;SET.fileCollections=SET.fileCollections.filter(x=>x.id!==c.id);saveSettings();paintFilesCollections();paintFilesMain()}}
    ])};
    wrap.appendChild(b);
  }
}
function currentFileSet(){
  const q=(($('fv-search')&&$('fv-search').value)||'').toLowerCase().trim();
  let list=(S.filesIndex||[]).slice();
  /* filter by current folder unless a "smart" section is active */
  const inSmart=/^__/.test(SET.filesActive||'')||(SET.filesActive&&(SET.fileCollections||[]).find(x=>x.id===SET.filesActive));
  if(!inSmart){
    const cur=SET.currentFolder||'';
    list=list.filter(f=>((SET.fileFolders||{})[f.blobId]||'')===cur);
  }
  if(SET.filesActive==='__starred')list=list.filter(f=>SET.starredFiles[f.blobId]);
  else if((SET.filesActive||'').startsWith('__contact:'))
    list=list.filter(f=>((f.from.email||f.from.name||'—'))===SET.filesActive.slice(10));
  else if((SET.filesActive||'').startsWith('__flag:'))
    list=list.filter(f=>(Array.isArray(f.flags)?f.flags:[]).some(x=>x.key===SET.filesActive.slice(7)));
  else if((SET.filesActive||'').startsWith('__dupes'))
    list=list.filter(f=>S.filesGroups&&S.filesGroups.dupeKeys.has(fileGroupKey(f)));
  else if(SET.filesActive){const c=(SET.fileCollections||[]).find(x=>x.id===SET.filesActive);
    if(c){const set=new Set(c.blobIds||[]);list=list.filter(f=>set.has(f.blobId))}}
  if(SET.filesFilter!=='all')list=list.filter(f=>f.kind===SET.filesFilter);
  if(q)list=list.filter(f=>(f.name||'').toLowerCase().includes(q)||
    ((f.from.name||f.from.email||'').toLowerCase().includes(q))||
    (f.subject||'').toLowerCase().includes(q));
  const cmp={
    'date-desc':(a,b)=>a.receivedAt<b.receivedAt?1:-1,
    'date-asc':(a,b)=>a.receivedAt>b.receivedAt?1:-1,
    'name-asc':(a,b)=>(a.name||'').localeCompare(b.name||''),
    'name-desc':(a,b)=>(b.name||'').localeCompare(a.name||''),
    'size-desc':(a,b)=>b.size-a.size,
    'size-asc':(a,b)=>a.size-b.size,
    'sender':(a,b)=>(a.from.name||a.from.email||'').localeCompare(b.from.name||b.from.email||'')
  };
  list.sort(cmp[SET.filesSort]||cmp['date-desc']);
  return list;
}
function paintFilesMain(){
  paintFilesUsage();paintFilesDupesSection();paintBreadcrumb();paintNavButtons();paintBinRow();paintDetailsPane();applyDetailsLayout();
  document.body.dataset.filesSize=SET.filesIconSize||'md';
  const main=$('fv-main');main.innerHTML='';
  main.oncontextmenu=ev=>{if(ev.target.closest('.fv-cell,.fv-folder'))return;ev.preventDefault();emptyContextMenu(main,ev)};
  main.ondragover=ev=>{ev.preventDefault()};
  attachMarquee(main);
  const inBin=SET.filesActive==='__bin';
  const items=currentViewItems();
  if(SET.filesView==='timeline'&&!inBin){paintFilesTimeline(main,items.filter(i=>i.kind==='file').map(i=>i.ref));mountDotRail(main);return}
  if(!items.length){
    main.innerHTML='<div class="fv-empty">'+(inBin?'Recycle Bin is empty.':(SET.currentFolder?'Empty folder. Right-click or use the New folder button to organise your files.':'Nothing here yet. Attachments across every mail folder show up automatically.'))+'</div>';
    return;
  }
  const subs=items.filter(i=>i.kind==='folder');
  const list=items.filter(i=>i.kind==='file').map(i=>i.ref);
  if(SET.filesView==='list'){
    const tbl=document.createElement('div');tbl.className='fv-tbl';
    const hdrs=[['name-asc','Name','name-desc'],['sender','Sender','sender'],['date-desc','Date','date-asc'],['size-desc','Size','size-asc']];
    const hdr=document.createElement('div');hdr.className='fv-tbl-h';
    for(const [asc,label,desc] of hdrs){
      const s=document.createElement('span');s.className='fv-hdr'+(SET.filesSort===asc||SET.filesSort===desc?' on':'');
      s.textContent=label+((SET.filesSort===asc)?' ▲':(SET.filesSort===desc)?' ▼':'');
      s.onclick=()=>{SET.filesSort=SET.filesSort===asc?desc:asc;saveSettings();paintFilesMain()};
      hdr.appendChild(s);
    }
    const spacer=document.createElement('span');hdr.appendChild(spacer);
    tbl.appendChild(hdr);
    for(const f of list){
      const r=document.createElement('div');r.className='fv-tbl-r';
      const t=FILE_TYPES.find(x=>x.key===f.kind)||FILE_TYPES[FILE_TYPES.length-1];
      r.innerHTML=`<span class="fv-nm"><span class="fv-mini" style="background:hsl(${t.hue} 62% 52% / .15);color:hsl(${t.hue} 62% 40%)">
        <svg viewBox="0 0 24 24"><path d="${fileIcon(f.kind)}"/></svg></span>
        <span class="fv-nm-t">${esc(f.name)}</span></span>
        <span class="fv-sm">${esc(f.from.name||f.from.email||'—')}</span>
        <span class="fv-sm">${esc(fmtDate(f.receivedAt))}</span>
        <span class="fv-sm">${esc(fmtSize(f.size))}</span>`;
      const c=document.createElement('span');c.className='fv-r-actions';
      appendFileActions(c,f);r.appendChild(c);
      r.onclick=ev=>{if(ev.target.closest('.fv-r-actions'))return;openFile(f)};
      tbl.appendChild(r);
    }
    main.appendChild(tbl);
    mountDotRail(main);return;
  }
  const grid=document.createElement('div');grid.className='fv-icons';
  grid.style.setProperty('--fv-icon-size',iconSizePx()+'px');
  /* folder tiles first (Windows-style) */
  for(const fdIt of subs){
    const fd=fdIt.ref;
    const cell=document.createElement('div');cell.className='fv-folder';
    if(S.filesSel.has(selKey(fdIt)))cell.classList.add('selected');
    if(S.filesFocus===selKey(fdIt))cell.classList.add('focused');
    cell.dataset.selkey=selKey(fdIt);
    cell.draggable=true;
    cell.ondragstart=ev=>{ev.dataTransfer.setData('vfolder',fd.id);ev.dataTransfer.effectAllowed='move';cell.classList.add('fv-dragging')};
    cell.ondragend=()=>cell.classList.remove('fv-dragging');
    const gid='fg-'+fd.id;
    cell.innerHTML=`<div class="fv-folder-glyph"><svg viewBox="0 0 88 68" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="hsl(45 90% 72%)"/><stop offset="1" stop-color="hsl(38 78% 55%)"/>
        </linearGradient>
        <linearGradient id="${gid}b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="hsl(45 88% 68%)"/><stop offset="1" stop-color="hsl(38 82% 52%)"/>
        </linearGradient>
      </defs>
      <path d="M4 12a4 4 0 0 1 4-4h20l8 8h48a4 4 0 0 1 4 4v40a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" style="fill:url(#${gid});stroke:hsl(38 60% 40%);stroke-width:1"/>
      <path d="M4 22a4 4 0 0 1 4-4h72a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" style="fill:url(#${gid}b);stroke:hsl(38 60% 42%);stroke-width:1"/>
      <ellipse cx="44" cy="18" rx="30" ry="1.6" style="fill:rgba(255,255,255,.55);stroke:none"/>
      </svg></div>
      <div class="fv-cell-name">${VfUi.esc(fd.name)}</div>
      <div class="fv-cell-sub">${folderItemCount(fd.id)} item${folderItemCount(fd.id)===1?'':'s'}</div>`;
    cell.ondblclick=()=>{if(SET.filesActive==='__bin')return;enterFolder(fd.id);pushHistory(fd.id)};
    cell.onclick=ev=>{handleItemClick(fdIt,ev)};
    cell.oncontextmenu=ev=>{ev.preventDefault();
      if(!S.filesSel.has(selKey(fdIt)))selectOnly(fdIt);
      paintFilesMain();
      folderContextMenu(fd,cell,ev,fdIt.binned)};
    cell.ondragover=ev=>{ev.preventDefault();cell.classList.add('fv-drop')};
    cell.ondragleave=()=>cell.classList.remove('fv-drop');
    cell.ondrop=ev=>{ev.preventDefault();cell.classList.remove('fv-drop');
      const b=ev.dataTransfer.getData('vfblob');if(b){moveFileToFolder(b,fd.id);paintFilesMain();toast('Moved to '+fd.name);return}
      const df=ev.dataTransfer.getData('vfolder');if(df&&df!==fd.id){const t=folderById(df);if(t){t.parentId=fd.id;saveSettings();paintFolderTree();paintFilesMain();toast('Moved into '+fd.name)}}};
    grid.appendChild(cell);
  }
  for(const f of list){
    const meta=(SET.fileMeta||{})[f.blobId]||{};
    const it={kind:'file',id:f.blobId,ref:f};
    const cell=document.createElement('div');cell.className='fv-cell';
    if(S.filesSel.has(selKey(it)))cell.classList.add('selected');
    if(S.filesFocus===selKey(it))cell.classList.add('focused');
    if(S.filesClipboard&&S.filesClipboard.op==='cut'&&S.filesClipboard.items.some(x=>x.kind==='file'&&x.id===f.blobId))cell.classList.add('cut');
    cell.dataset.selkey=selKey(it);
    cell.draggable=true;
    cell.ondragstart=ev=>{ev.dataTransfer.setData('vfblob',f.blobId);ev.dataTransfer.effectAllowed='copyMove';cell.classList.add('fv-dragging')};
    cell.ondragend=()=>cell.classList.remove('fv-dragging');
    cell.appendChild(fileGlyph(f));
    const flagArr=Array.isArray(f.flags)?f.flags:[];
    const flagsHtml=flagArr.map(fl=>`<span class="fv-flag" style="--fh:${fl.hue}">${VfUi.esc(fl.label)}</span>`).join('');
    const gk=fileGroupKey(f);
    const isDupe=S.filesGroups&&S.filesGroups.dupeKeys.has(gk);
    const isVersion=S.filesGroups&&S.filesGroups.versionKeys.has(gk);
    let statusPill='';
    if(isDupe)statusPill='<span class="fv-flag fv-flag-warn">Duplicate</span>';
    else if(isVersion)statusPill='<span class="fv-flag fv-flag-alt">Version</span>';
    const nm=document.createElement('div');nm.className='fv-cell-name';nm.title=f.name;nm.textContent=displayName(f);
    const sub=document.createElement('div');sub.className='fv-cell-sub';sub.textContent=fmtSize(f.size)+' · '+fmtDate(f.receivedAt);
    cell.appendChild(nm);cell.appendChild(sub);
    if(flagsHtml||statusPill){
      const fr=document.createElement('div');fr.className='fv-cell-flags';fr.innerHTML=flagsHtml+statusPill;
      cell.appendChild(fr);
    }
    if(meta.notes){
      const n=document.createElement('div');n.className='fv-cell-notes';n.title=meta.notes;
      n.innerHTML='<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
      cell.appendChild(n);
    }
    cell.onclick=ev=>{handleItemClick(it,ev)};
    cell.ondblclick=()=>{if(SET.filesActive==='__bin')return;openFile(f)};
    cell.oncontextmenu=ev=>{ev.preventDefault();
      if(!S.filesSel.has(selKey(it)))selectOnly(it);
      paintFilesMain();
      fileContextMenu(f,cell,ev,it.binned)};
    grid.appendChild(cell);
  }
  main.appendChild(grid);
  mountDotRail(main);
}
function handleItemClick(item,ev){
  const items=currentViewItems();
  if(ev.shiftKey&&S.filesFocus){
    if(!ev.ctrlKey&&!ev.metaKey)S.filesSel.clear();
    rangeSelect(items,S.filesFocus,selKey(item));
  }else if(ev.ctrlKey||ev.metaKey){
    toggleSel(item);
  }else{
    selectOnly(item);
  }
  paintFilesMain();
}
/* ---- marquee (rubber-band drag rectangle) ---- */
/* ---- address bar ---- */
function toggleAddressBar(){
  const crumbs=$('fv-crumbs'),addr=$('fv-address');
  const showing=addr.classList.toggle('hidden');
  if(!showing){addr.classList.remove('hidden');crumbs.classList.add('hidden');addr.value='/'+folderPath(SET.currentFolder).map(f=>f.name).join('/');addr.focus();addr.select()}
  else{crumbs.classList.remove('hidden')}
}
function navigateByPath(p){
  const parts=(p||'').split('/').map(s=>s.trim()).filter(Boolean);
  let cur='';
  for(const name of parts){
    const f=(SET.folders||[]).find(x=>(x.parentId||'')===cur&&x.name.toLowerCase()===name.toLowerCase());
    if(!f){toast('Folder "'+name+'" not found');return}
    cur=f.id;
  }
  SET.currentFolder=cur;pushHistory(cur);clearSel();paintFilesMain();paintFolderTree();
}

/* ---- details pane (Alt+P) ---- */
function applyDetailsLayout(){$('fv-details').classList.toggle('hidden',!SET.filesShowDetails)}
function paintDetailsPane(){
  const wrap=$('fv-details');if(!wrap)return;
  if(!SET.filesShowDetails){wrap.classList.add('hidden');return}
  wrap.classList.remove('hidden');
  const focusItem=currentViewItems().find(i=>selKey(i)===S.filesFocus);
  if(!focusItem){wrap.innerHTML='<div class="fv-details-empty">Select a file to see its details.</div>';return}
  if(focusItem.kind==='folder'){
    wrap.innerHTML=`<div class="fv-details-hero"><svg viewBox="0 0 88 68" style="width:100%;height:auto"><path d="M4 12a4 4 0 0 1 4-4h20l8 8h48a4 4 0 0 1 4 4v40a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" style="fill:#f5c453"/><path d="M4 22h80v38a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" style="fill:#f8d67a"/></svg></div>
      <div class="fv-details-name">${VfUi.esc(focusItem.ref.name)}</div>
      <div class="fv-details-sub">${folderItemCount(focusItem.id)} item${folderItemCount(focusItem.id)===1?'':'s'}</div>`;
    return;
  }
  const f=focusItem.ref;
  wrap.innerHTML='';
  const hero=document.createElement('div');hero.className='fv-details-hero';
  if(f.kind==='image'){const im=document.createElement('img');im.src=downloadUrl(f.blobId,f.name);im.style.maxWidth='100%';im.style.borderRadius='8px';hero.appendChild(im)}
  else hero.appendChild(fileGlyph(f));
  const rows=[
    ['Name',displayName(f)],
    ['Type',(f.type||'—')],
    ['Size',fmtSize(f.size)],
    ['Received',new Date(f.receivedAt).toLocaleString([],{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})],
    ['From',(f.from&&(f.from.name||f.from.email))||'—'],
    ['Subject',f.subject||'—']
  ];
  const rowsEl=document.createElement('div');rowsEl.className='fv-details-rows';
  for(const [k,v] of rows)rowsEl.innerHTML+=`<div><b>${VfUi.esc(k)}</b><span>${VfUi.esc(v)}</span></div>`;
  wrap.appendChild(hero);
  const nm=document.createElement('div');nm.className='fv-details-name';nm.textContent=displayName(f);
  wrap.appendChild(nm);wrap.appendChild(rowsEl);
}

/* ---- Alt+P shortcut ---- */
document.addEventListener('keydown',e=>{
  if(e.altKey&&(e.key==='p'||e.key==='P')&&!$('files-view').classList.contains('hidden')){
    e.preventDefault();SET.filesShowDetails=!SET.filesShowDetails;saveSettings();applyDetailsLayout();paintDetailsPane();
  }
});

function attachMarquee(main){
  main.onmousedown=e=>{
    if(e.button!==0||e.target.closest('.fv-cell,.fv-folder'))return;
    if(!(e.shiftKey||e.ctrlKey||e.metaKey))clearSel();
    const rect=document.createElement('div');rect.className='fv-marquee';main.appendChild(rect);
    const startX=e.pageX,startY=e.pageY;
    const move=ev=>{
      const x=Math.min(startX,ev.pageX)-main.getBoundingClientRect().left;
      const y=Math.min(startY,ev.pageY)-main.getBoundingClientRect().top;
      const w=Math.abs(startX-ev.pageX),h=Math.abs(startY-ev.pageY);
      rect.style.left=x+'px';rect.style.top=y+'px';rect.style.width=w+'px';rect.style.height=h+'px';
      const r={left:x,top:y,right:x+w,bottom:y+h};
      const mainBox=main.getBoundingClientRect();
      for(const cell of main.querySelectorAll('.fv-cell,.fv-folder')){
        const b=cell.getBoundingClientRect();
        const cb={left:b.left-mainBox.left+main.scrollLeft,top:b.top-mainBox.top+main.scrollTop,right:b.right-mainBox.left+main.scrollLeft,bottom:b.bottom-mainBox.top+main.scrollTop};
        const hit=!(cb.left>r.right||cb.right<r.left||cb.top>r.bottom||cb.bottom<r.top);
        if(hit)S.filesSel.add(cell.dataset.selkey);else if(!(e.shiftKey||e.ctrlKey||e.metaKey))S.filesSel.delete(cell.dataset.selkey);
        cell.classList.toggle('selected',S.filesSel.has(cell.dataset.selkey));
      }
    };
    const up=()=>{rect.remove();removeEventListener('mousemove',move);removeEventListener('mouseup',up);paintFilesMain()};
    addEventListener('mousemove',move);addEventListener('mouseup',up);
    e.preventDefault();
  };
}

/* ---- history nav buttons + address bar ---- */
function paintNavButtons(){
  const back=$('fv-back'),fwd=$('fv-fwd'),up=$('fv-up');
  if(back)back.disabled=S.filesHistoryPos<=0;
  if(fwd)fwd.disabled=S.filesHistoryPos>=S.filesHistory.length-1;
  if(up)up.disabled=!SET.currentFolder;
}
function paintBinRow(){
  const wrap=$('fv-bin-row');if(!wrap)return;wrap.innerHTML='';
  const n=Object.keys(SET.filesBin||{}).length+Object.keys(SET.foldersBin||{}).length;
  const b=document.createElement('button');b.className='fv-col-item'+(SET.filesActive==='__bin'?' on':'');
  b.innerHTML=`<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>
    <span>Recycle Bin</span><span class="fv-col-n">${n}</span>`;
  b.onclick=()=>{SET.filesActive=SET.filesActive==='__bin'?'':'__bin';clearSel();paintFilesTypes();paintFilesCollections();paintFolderTree();paintFilesMain()};
  wrap.appendChild(b);
  if(n){
    const em=document.createElement('button');em.className='sp-linkbtn danger';em.textContent='Empty bin';em.onclick=emptyBin;
    wrap.appendChild(em);
  }
}

/* ---- keyboard shortcuts ---- */
function armFilesKeys(){
  document.addEventListener('keydown',e=>{
    const inFiles=!$('files-view').classList.contains('hidden');
    if(!inFiles)return;
    if(S.filesRenaming){/* let input handle its own keys */return}
    const tag=(e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||e.target.isContentEditable)return;
    const items=currentViewItems();
    const focusItem=items.find(i=>selKey(i)===S.filesFocus);
    if((e.ctrlKey||e.metaKey)&&e.key==='a'){e.preventDefault();S.filesSel=new Set(items.map(selKey));paintFilesMain();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='c'){e.preventDefault();copySelection('copy');return}
    if((e.ctrlKey||e.metaKey)&&e.key==='x'){e.preventDefault();copySelection('cut');return}
    if((e.ctrlKey||e.metaKey)&&e.key==='v'){e.preventDefault();pasteHere();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();doUndo();return}
    if(e.key==='F5'){e.preventDefault();ensureFilesIndex(true).then(()=>paintFilesMain());return}
    if(e.key==='F2'&&focusItem){e.preventDefault();
      const cell=document.querySelector('.fv-cell.focused,.fv-folder.focused');if(cell)beginRename(focusItem,cell);return}
    if(e.key==='Delete'){e.preventDefault();deleteSelectionToBin();return}
    if(e.key==='Backspace'){e.preventDefault();historyUp();return}
    if(e.key==='Enter'&&focusItem){e.preventDefault();
      if(focusItem.kind==='folder')enterFolder(focusItem.id),pushHistory(focusItem.id);
      else openFile(focusItem.ref);return}
    if(e.key==='Escape'){clearSel();paintFilesMain();return}
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();navFocus(e.key,e.shiftKey);return}
  });
}
function navFocus(key,shift){
  const cells=[...$('fv-main').querySelectorAll('.fv-cell,.fv-folder')];
  if(!cells.length)return;
  let idx=cells.findIndex(c=>c.classList.contains('focused'));
  if(idx<0)idx=0;
  /* compute grid columns from actual layout */
  const first=cells[0].getBoundingClientRect();let cols=1;
  for(const c of cells){const b=c.getBoundingClientRect();if(Math.abs(b.top-first.top)<2)cols++;else break}
  cols=Math.max(1,cols-1);
  let n=idx;
  if(key==='ArrowRight')n=Math.min(cells.length-1,idx+1);
  if(key==='ArrowLeft')n=Math.max(0,idx-1);
  if(key==='ArrowDown')n=Math.min(cells.length-1,idx+cols);
  if(key==='ArrowUp')n=Math.max(0,idx-cols);
  const items=currentViewItems();
  const item=items[n];if(!item)return;
  if(shift&&S.filesFocus){rangeSelect(items,S.filesFocus,selKey(item))}
  else{selectOnly(item)}
  paintFilesMain();
  const target=$('fv-main').querySelectorAll('.fv-cell,.fv-folder')[n];
  if(target)target.scrollIntoView({block:'nearest'});
}
function deleteSelectionToBin(){
  const items=currentViewItems().filter(i=>S.filesSel.has(selKey(i)));
  if(!items.length)return;
  const before=JSON.parse(JSON.stringify({filesBin:SET.filesBin||{},foldersBin:SET.foldersBin||{},fileFolders:SET.fileFolders||{},folders:SET.folders||[]}));
  for(const it of items){
    if(it.kind==='file')binFile(it.ref);else binFolder(it.id);
  }
  pushUndo({label:'Delete '+items.length+' item'+(items.length===1?'':'s'),before});
  clearSel();paintFolderTree();paintFilesMain();
  toast(items.length+' item'+(items.length===1?'':'s')+' moved to Recycle Bin');
}

function folderContextMenu(fd,anchor,ev,binned){
  const items=binned?[
    {label:'Restore',onclick:()=>{unbinFolder(fd.id);paintFolderTree();paintFilesMain();paintBinRow();toast('Restored')}},
    {label:'Delete permanently',onclick:()=>{delete SET.foldersBin[fd.id];saveSettings();paintFilesMain();paintBinRow();toast('Removed from bin')}}
  ]:[
    {label:'Open',onclick:()=>{enterFolder(fd.id);pushHistory(fd.id)}},
    '—',
    {label:'Cut',onclick:()=>copySelection('cut')},
    {label:'Copy',onclick:()=>copySelection('copy')},
    {label:'Paste',onclick:pasteHere},
    '—',
    {label:'New subfolder…',onclick:()=>{if(createFolder(fd.id))paintFilesMain()}},
    {label:'Rename (F2)',onclick:()=>{const cell=document.querySelector('[data-selkey="folder:'+fd.id+'"]');if(cell)beginRename({kind:'folder',id:fd.id,ref:fd},cell)}},
    {label:'Delete',onclick:deleteSelectionToBin},
    '—',
    {label:'Properties…',onclick:()=>toast('Folder properties coming next')}
  ];
  showMenu(anchor,items);
  const m=document.getElementById('menu');
  if(ev){m.style.left=Math.min(ev.clientX,innerWidth-m.offsetWidth-8)+'px';
    m.style.top=Math.min(ev.clientY,innerHeight-m.offsetHeight-8)+'px'}
}
function emptyContextMenu(anchor,ev){
  const cur=SET.currentFolder||'';
  const items=[
    {label:'New folder…',onclick:()=>{if(createFolder(cur))paintFilesMain()}},
    '—',
    {label:'Paste',onclick:pasteHere},
    '—',
    {label:'Sort by',onclick:e=>{e.stopPropagation();sortByMenu(anchor)}},
    {label:'Group by',onclick:e=>{e.stopPropagation();groupByMenu(anchor)}},
    {label:'View',onclick:e=>{e.stopPropagation();viewMenu(anchor)}},
    '—',
    {label:'Refresh (F5)',onclick:()=>ensureFilesIndex(true).then(()=>paintFilesMain())}
  ];
  if(cur){
    const f=folderById(cur);
    items.push('—',{label:'Rename this folder…',onclick:()=>{renameFolder(cur);paintFilesMain()}});
    items.push({label:'Go up one level',onclick:historyUp});
  }
  showMenu(anchor,items);
  const m=document.getElementById('menu');
  m.style.left=Math.min(ev.clientX,innerWidth-m.offsetWidth-8)+'px';
  m.style.top=Math.min(ev.clientY,innerHeight-m.offsetHeight-8)+'px';
}
function sortByMenu(anchor){
  const opts=[['date-desc','Newest first'],['date-asc','Oldest first'],['name-asc','Name A→Z'],['name-desc','Name Z→A'],['size-desc','Largest first'],['size-asc','Smallest first'],['sender','Sender A→Z']];
  showMenu(anchor,opts.map(([v,l])=>({label:l,check:SET.filesSort===v,onclick:()=>{SET.filesSort=v;$('fv-sort').value=v;saveSettings();paintFilesMain()}})));
}
function groupByMenu(anchor){
  const opts=[['none','(No grouping)'],['type','Type'],['date','Date'],['sender','Sender'],['size','Size']];
  showMenu(anchor,opts.map(([v,l])=>({label:l,check:SET.filesGroupBy===v,onclick:()=>{SET.filesGroupBy=v;saveSettings();paintFilesMain()}})));
}
function viewMenu(anchor){
  showMenu(anchor,[
    {label:'Extra small icons',check:SET.filesIconSize==='xs',onclick:()=>{SET.filesIconSize='xs';saveSettings();paintFilesMain()}},
    {label:'Small icons',check:SET.filesIconSize==='sm',onclick:()=>{SET.filesIconSize='sm';saveSettings();paintFilesMain()}},
    {label:'Medium icons',check:SET.filesIconSize==='md',onclick:()=>{SET.filesIconSize='md';saveSettings();paintFilesMain()}},
    {label:'Large icons',check:SET.filesIconSize==='lg',onclick:()=>{SET.filesIconSize='lg';saveSettings();paintFilesMain()}},
    {label:'Extra large icons',check:SET.filesIconSize==='xl',onclick:()=>{SET.filesIconSize='xl';saveSettings();paintFilesMain()}},
    '—',
    {label:(SET.filesHideExt?'Show':'Hide')+' file extensions',onclick:()=>{SET.filesHideExt=!SET.filesHideExt;saveSettings();paintFilesMain()}},
    {label:(SET.filesShowDetails?'Hide':'Show')+' details pane (Alt+P)',onclick:()=>{SET.filesShowDetails=!SET.filesShowDetails;saveSettings();paintDetailsPane();applyDetailsLayout()}}
  ]);
}
function fileContextMenu(f,anchor,ev,binned){
  const items=binned?[
    {label:'Restore',onclick:()=>{unbinFile(f.blobId);paintFilesMain();paintBinRow();toast('Restored')}},
    {label:'Delete permanently',onclick:()=>{delete SET.filesBin[f.blobId];saveSettings();paintFilesMain();paintBinRow();toast('Removed from bin')}}
  ]:[
    {label:'Open',onclick:()=>openFile(f)},
    '—',
    {label:'Cut (Ctrl+X)',onclick:()=>copySelection('cut')},
    {label:'Copy (Ctrl+C)',onclick:()=>copySelection('copy')},
    '—',
    {label:'Rename (F2)',onclick:()=>{const cell=document.querySelector('[data-selkey="file:'+f.blobId+'"]');if(cell)beginRename({kind:'file',id:f.blobId,ref:f},cell)}},
    {label:'Delete (Del)',onclick:deleteSelectionToBin},
    '—',
    {label:'Send to',onclick:e=>{e.stopPropagation();sendToMenu(anchor)}},
    {label:'Download',onclick:()=>downloadFile(f)},
    {label:'Send again',onclick:()=>sendFileAgain(f)},
    {label:'Open source mail',onclick:()=>openThread(f.threadId).catch(err)},
    '—',
    {label:'Move to folder…',onclick:()=>moveToFolderMenu(f,anchor)},
    {label:SET.starredFiles[f.blobId]?'Unstar':'Star',onclick:()=>toggleFileStar(f)},
    {label:'Add to collection…',onclick:()=>collectFileMenu(f,anchor)},
    '—',
    {label:'Properties…',onclick:()=>openFileProperties(f)}
  ];
  showMenu(anchor,items);
  const m=document.getElementById('menu');
  if(ev){m.style.left=Math.min(ev.clientX,innerWidth-m.offsetWidth-8)+'px';
    m.style.top=Math.min(ev.clientY,innerHeight-m.offsetHeight-8)+'px'}
}
function paintFilesTimeline(main,list){
  main.innerHTML='';
  const groups={};
  for(const f of list){
    const d=new Date(f.receivedAt);
    const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    (groups[k]=groups[k]||[]).push(f);
  }
  const keys=Object.keys(groups).sort().reverse();
  const wrap=document.createElement('div');wrap.className='fv-tl';
  for(const k of keys){
    const sec=document.createElement('section');sec.className='fv-tl-month';
    const [y,mo]=k.split('-');
    const label=new Date(+y,+mo-1,1).toLocaleDateString([],{month:'long',year:'numeric'});
    sec.innerHTML=`<div class="fv-tl-h">${esc(label)} <span>${groups[k].length}</span></div>`;
    const row=document.createElement('div');row.className='fv-tl-row';
    for(const f of groups[k].sort((a,b)=>a.receivedAt<b.receivedAt?1:-1)){
      const t=FILE_TYPES.find(x=>x.key===f.kind)||FILE_TYPES[FILE_TYPES.length-1];
      const chip=document.createElement('button');chip.className='fv-tl-chip';chip.title=f.name;
      chip.style.setProperty('--kh',t.hue);
      const d=new Date(f.receivedAt);
      chip.innerHTML=`<span class="fv-tl-d">${d.getDate()}</span>
        <span class="fv-mini" style="background:hsl(${t.hue} 62% 52% / .18);color:hsl(${t.hue} 62% 40%)">
          <svg viewBox="0 0 24 24"><path d="${fileIcon(f.kind)}"/></svg></span>
        <span class="fv-tl-n">${esc(f.name)}</span>
        <span class="fv-tl-sz">${esc(fmtSize(f.size))}</span>`;
      chip.onclick=()=>openFile(f);
      row.appendChild(chip);
    }
    sec.appendChild(row);wrap.appendChild(sec);
  }
  main.appendChild(wrap);
}
function paintFilesDupesSection(){
  const wrap=$('fv-dupes');if(!wrap)return;wrap.innerHTML='';
  const dupeN=S.filesGroups?S.filesGroups.dupeKeys.size:0;
  const vN=S.filesGroups?S.filesGroups.versionKeys.size:0;
  if(!dupeN&&!vN){wrap.innerHTML='<div class="fv-side-empty">All clean</div>';return}
  if(dupeN){
    const b=document.createElement('button');b.className='fv-col-item'+(SET.filesActive==='__dupes'?' on':'');
    b.innerHTML=`<span class="fv-flag-dot" style="background:#e63b19"></span><span>Duplicates</span><span class="fv-col-n">${dupeN}</span>`;
    b.onclick=()=>{SET.filesActive=SET.filesActive==='__dupes'?'':'__dupes';SET.filesFilter='all';paintFilesTypes();paintFilesCollections();paintFilesContacts();paintFilesFlags();paintFilesDupesSection();paintFilesMain()};
    wrap.appendChild(b);
  }
  if(vN){
    const b=document.createElement('div');b.className='fv-side-note';
    b.textContent=vN+' version stack'+(vN===1?'':'s')+' detected';
    wrap.appendChild(b);
  }
}
async function importFromDevice(files){
  if(!files||!files.length)return;
  const drafts=S.byRole.drafts,sent=S.byRole.sent;
  toast('Uploading '+files.length+' file'+(files.length===1?'':'s')+' to self…');
  const uploaded=[];
  for(const f of files){
    const r=await fetch(jmapUrl(`/jmap/upload/${S.acct}/`),{method:'POST',
      headers:{Authorization:'Basic '+S.token,'Content-Type':f.type||'application/octet-stream'},body:f}).catch(err);
    if(!r||!r.ok)continue;
    const j=await r.json();
    uploaded.push({blobId:j.blobId,name:f.name,type:j.type||f.type||'application/octet-stream',size:j.size||f.size});
  }
  if(!uploaded.length)return toast('Upload failed');
  const alt={type:'multipart/alternative',subParts:[{partId:'t',type:'text/plain'},{partId:'h',type:'text/html'}]};
  const structure={type:'multipart/mixed',subParts:[alt].concat(uploaded.map(a=>({blobId:a.blobId,type:a.type,name:a.name,disposition:'attachment'})))};
  const stamp=new Date().toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const obj={mailboxIds:{[drafts.id]:true},keywords:{$seen:true,$draft:true},
    from:[{name:'VF Mail',email:S.user}],to:[{email:S.user}],
    subject:'📎 Archived '+uploaded.length+' file'+(uploaded.length===1?'':'s')+' — '+stamp,
    bodyValues:{t:{value:'Imported from device on '+stamp},h:{value:'<p><em>Imported from device on '+stamp+'</em></p>'}},
    bodyStructure:structure};
  const rs=await jmap([
    ['Email/set',{accountId:S.acct,create:{d:obj}},'0'],
    ['EmailSubmission/set',{accountId:S.acct,create:{s:{emailId:'#d',identityId:S.identity.id}},
      onSuccessUpdateEmail:{'#s':{['mailboxIds/'+drafts.id]:null,['mailboxIds/'+(sent?sent.id:drafts.id)]:true,['keywords/$draft']:null,['keywords/$archived-file']:true}}},'1']]).catch(err);
  if(!rs)return toast('Import failed');
  toast(uploaded.length+' file'+(uploaded.length===1?'':'s')+' archived to your inbox');
  await ensureFilesIndex(true);paintFilesTypes();paintFilesCollections();paintFilesContacts();paintFilesFlags();paintFilesMain();
}
function iconEl(kind){
  const t=FILE_TYPES.find(x=>x.key===kind)||FILE_TYPES[FILE_TYPES.length-1];
  const w=document.createElement('div');w.className='fv-thumb-icon';
  w.style.color=`hsl(${t.hue} 62% 45%)`;
  w.innerHTML=`<svg viewBox="0 0 24 24"><path d="${fileIcon(kind)}"/></svg>`;
  return w;
}
/* rich Explorer-style file icon — dog-eared sheet + type badge + colour */
function fileGlyph(f){
  const kind=f.kind||fileTypeKey(f);
  const t=FILE_TYPES.find(x=>x.key===kind)||FILE_TYPES[FILE_TYPES.length-1];
  const ext=(f.name||'').split('.').pop().toUpperCase().slice(0,4)||'FILE';
  const hue=t.hue;
  const meta=(SET.fileMeta||{})[f.blobId]||{};
  const tag=meta.color||'';
  const wrap=document.createElement('div');wrap.className='fv-glyph';
  wrap.style.setProperty('--kh',hue);
  const isImage=kind==='image';
  wrap.innerHTML=`
    <svg viewBox="0 0 68 84" class="fv-sheet" aria-hidden="true">
      <defs>
        <linearGradient id="fs-${hue}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="hsl(${hue} 60% 98%)"/>
          <stop offset="1" stop-color="hsl(${hue} 45% 90%)"/>
        </linearGradient>
        <linearGradient id="fc-${hue}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${hue} 45% 80%)"/>
          <stop offset="1" stop-color="hsl(${hue} 30% 68%)"/>
        </linearGradient>
      </defs>
      <path d="M6 3h40l18 18v58a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="url(#fs-${hue})" stroke="hsl(${hue} 40% 70%)" stroke-width="1"/>
      <path d="M46 3v18h18" fill="url(#fc-${hue})" stroke="hsl(${hue} 40% 60%)" stroke-width="1"/>
      <g class="fv-sheet-inner" transform="translate(0 6)">
        ${kindInnerArt(kind,hue)}
      </g>
      <rect class="fv-ext-plate" x="6" y="60" width="42" height="16" rx="4" fill="hsl(${hue} 55% 45%)"/>
      <text x="27" y="72" text-anchor="middle" font-family="'Playfair Display',serif" font-size="10.5" fill="#fff" font-weight="700" letter-spacing=".08em">${VfUi.esc(ext)}</text>
    </svg>
    ${tag?`<span class="fv-glyph-tag" style="background:${tag}"></span>`:''}
    ${SET.starredFiles[f.blobId]?'<span class="fv-glyph-star"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z"/></svg></span>':''}
    ${isImage?`<img class="fv-glyph-thumb" loading="lazy" src="${downloadUrl(f.blobId,f.name)}" onerror="this.remove()">`:''}
  `;
  return wrap;
}
function kindInnerArt(kind,hue){
  const line=(x,y,w=32)=>`<rect x="${x}" y="${y}" width="${w}" height="2.2" rx="1" fill="hsl(${hue} 30% 55%)" opacity=".6"/>`;
  const art={
    image:'<circle cx="18" cy="30" r="4" fill="hsl(46 92% 58%)"/><path d="M8 44l10-8 8 6 14-10v18H8z" fill="hsl(210 55% 60%)"/>',
    pdf:`${line(10,26)}${line(10,32,28)}${line(10,38)}<text x="27" y="52" text-anchor="middle" font-family="'Playfair Display',serif" font-size="11" font-weight="700" fill="hsl(${hue} 45% 50%)">PDF</text>`,
    doc:`${line(10,24)}${line(10,30,30)}${line(10,36,26)}${line(10,42,32)}${line(10,48,22)}`,
    sheet:`<g stroke="hsl(${hue} 40% 55%)" stroke-width="1.4" opacity=".7">
      <path d="M8 22h40M8 30h40M8 38h40M8 46h40M20 22v28M32 22v28M42 22v28"/></g>`,
    slide:`<rect x="10" y="24" width="34" height="22" rx="2" fill="hsl(${hue} 45% 70%)" opacity=".5"/>
      <path d="M18 32l6 5 10-8" stroke="hsl(${hue} 60% 40%)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    video:`<circle cx="27" cy="34" r="14" fill="hsl(${hue} 60% 55%)" opacity=".22"/>
      <path d="M23 28l12 6-12 6z" fill="hsl(${hue} 60% 40%)"/>`,
    audio:`<g stroke="hsl(${hue} 55% 45%)" stroke-width="2" stroke-linecap="round" fill="none">
      <path d="M14 40V26l24-4v14"/><circle cx="14" cy="42" r="4" fill="hsl(${hue} 55% 45%)"/><circle cx="38" cy="38" r="4" fill="hsl(${hue} 55% 45%)"/></g>`,
    archive:`<rect x="8" y="22" width="40" height="8" rx="1" fill="hsl(${hue} 45% 70%)" opacity=".6"/>
      <rect x="10" y="32" width="36" height="18" rx="1" fill="hsl(${hue} 35% 78%)" opacity=".5"/>
      <rect x="25" y="26" width="6" height="10" fill="hsl(${hue} 55% 45%)"/>`,
    other:`${line(10,26)}${line(10,32,28)}${line(10,38)}${line(10,44,24)}`
  };
  return art[kind]||art.other;
}
function appendFileActions(host,f){
  const mk=(icon,tip,fn)=>{const b=document.createElement('button');b.className='iconbtn';b.setAttribute('data-tip',tip);
    b.innerHTML=`<svg viewBox="0 0 24 24"><path d="${icon}"/></svg>`;b.onclick=e=>{e.stopPropagation();fn()};return b};
  host.appendChild(mk('M12 3l2.7 5.9 6.3.6-4.8 4.3 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.5l6.3-.6z',
    SET.starredFiles[f.blobId]?'Unstar':'Star',()=>toggleFileStar(f)));
  const star=host.lastChild;if(SET.starredFiles[f.blobId])star.classList.add('on');
  host.appendChild(mk('M12 3v14M6 11l6 6 6-6M4 21h16','Download',()=>downloadFile(f)));
  host.appendChild(mk('M22 2L11 13M22 2l-7 20-4-9-9-4z','Send again',()=>sendFileAgain(f)));
  host.appendChild(mk('M3 12h5l2 3h4l2-3h5M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    'Open source mail',()=>openThread(f.threadId).catch(err)));
  host.appendChild(mk('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'Add to collection…',(e)=>collectFileMenu(f,star)));
}
function openFileProperties(f){
  const m=$('fv-props'),body=$('fv-props-body');
  SET.fileMeta=SET.fileMeta||{};
  SET.fileMeta[f.blobId]=SET.fileMeta[f.blobId]||{color:'',notes:''};
  const meta=SET.fileMeta[f.blobId];
  body.innerHTML='';
  const wrap=document.createElement('div');wrap.className='fv-props-wrap';
  const left=document.createElement('div');left.className='fv-props-hero';
  const bigGlyph=fileGlyph(f);bigGlyph.classList.add('fv-glyph-lg');
  left.appendChild(bigGlyph);
  const openBtn=document.createElement('button');openBtn.className='btn-ghost';openBtn.textContent=f.kind==='image'?'Open preview':'Open in browser';
  openBtn.onclick=()=>openFile(f);
  left.appendChild(openBtn);
  wrap.appendChild(left);
  const right=document.createElement('div');right.className='fv-props-detail';
  const rows=[
    ['Name',f.name],
    ['Type',(f.type||'—')+(fileExt(f.name)?' · .'+fileExt(f.name):'')],
    ['Kind',(FILE_TYPES.find(x=>x.key===f.kind)||{}).label||'—'],
    ['Size',fmtSize(f.size)],
    ['Received',new Date(f.receivedAt).toLocaleString([],{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})],
    ['From',(f.from&&(f.from.name||f.from.email))||'—'],
    ['Subject',f.subject||'—'],
    ['Blob ID',f.blobId]
  ];
  const list=document.createElement('div');list.className='fv-props-rows';
  for(const [k,v] of rows){
    const r=document.createElement('div');r.className='fv-props-row';
    r.innerHTML=`<span class="fv-props-k">${VfUi.esc(k)}</span><span class="fv-props-v">${VfUi.esc(v||'—')}</span>`;
    list.appendChild(r);
  }
  right.appendChild(list);
  const flagArr=Array.isArray(f.flags)?f.flags:[];
  if(flagArr.length){
    const fh=document.createElement('div');fh.className='fv-props-flags';
    fh.innerHTML=flagArr.map(fl=>`<span class="fv-flag" style="--fh:${fl.hue}">${VfUi.esc(fl.label)}</span>`).join('');
    right.appendChild(fh);
  }
  /* colour tag */
  const cw=document.createElement('div');cw.className='fv-props-color';
  cw.innerHTML='<div class="fv-props-h">Colour tag</div>';
  const swatches=document.createElement('div');swatches.className='fv-props-swatches';
  const palette=['','#e63b19','#f59e0b','#eab308','#22c55e','#0891b2','#1f6ff2','#8b5cf6','#ec4899'];
  for(const c of palette){
    const s=document.createElement('button');s.className='fv-props-sw'+(meta.color===c?' on':'');
    s.style.background=c||'transparent';if(!c)s.innerHTML='<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    s.onclick=()=>{meta.color=c;saveSettings();
      document.querySelectorAll('.fv-props-sw').forEach(x=>x.classList.remove('on'));s.classList.add('on');
      paintFilesMain();
    };
    swatches.appendChild(s);
  }
  cw.appendChild(swatches);
  right.appendChild(cw);
  /* notes */
  const nw=document.createElement('div');nw.className='fv-props-notes';
  nw.innerHTML='<div class="fv-props-h">Notes</div>';
  const nt=document.createElement('textarea');nt.rows=3;nt.className='sp-txt sp-area';nt.placeholder='Personal notes about this file…';nt.value=meta.notes||'';
  nt.oninput=VfUi.debounce(()=>{meta.notes=nt.value;saveSettings();paintFilesMain()},250);
  nw.appendChild(nt);
  right.appendChild(nw);
  /* actions */
  const actions=document.createElement('div');actions.className='fv-props-actions';
  const btn=(t,fn)=>{const b=document.createElement('button');b.className='btn-ghost';b.textContent=t;b.onclick=fn;return b};
  actions.appendChild(btn('Download',()=>downloadFile(f)));
  actions.appendChild(btn('Send again',()=>{m.classList.add('hidden');sendFileAgain(f)}));
  actions.appendChild(btn(SET.starredFiles[f.blobId]?'Unstar':'Star',()=>{toggleFileStar(f);openFileProperties(f)}));
  actions.appendChild(btn('Open source mail',()=>{m.classList.add('hidden');openThread(f.threadId).catch(err)}));
  actions.appendChild(btn('Add to collection…',(e)=>collectFileMenu(f,e.target)));
  right.appendChild(actions);
  wrap.appendChild(right);
  body.appendChild(wrap);
  m.classList.remove('hidden');
}
function fileExt(name){return (name||'').split('.').pop().toLowerCase()}
function sendToMenu(anchor){
  showMenu(anchor,[
    {label:'Compressed (.zip) folder',onclick:()=>{if(!S.filesSel.size)selectOnly(currentViewItems().find(i=>i.id===this));zipSelection().catch(err)}},
    {label:'Mail recipient',onclick:sendSelectionByMail}
  ]);
}
function moveToFolderMenu(f,anchor){
  const items=[];
  const cur=(SET.fileFolders||{})[f.blobId]||'';
  items.push({label:'(Root · no folder)',check:!cur,onclick:()=>{moveFileToFolder(f.blobId,'');paintFilesMain();paintFolderTree();toast('Moved to root')}});
  const flat=[];
  function walk(pid,depth){
    for(const fd of folderChildren(pid).sort((a,b)=>a.name.localeCompare(b.name))){
      flat.push({fd,depth});walk(fd.id,depth+1);
    }
  }
  walk('',0);
  for(const {fd,depth} of flat){
    items.push({label:fd.name,indent:depth,check:cur===fd.id,onclick:()=>{moveFileToFolder(f.blobId,fd.id);paintFilesMain();paintFolderTree();toast('Moved to '+fd.name)}});
  }
  items.push('—',{label:'+ New folder here',onclick:()=>{const nf=createFolder(cur);if(nf){moveFileToFolder(f.blobId,nf.id);paintFolderTree();paintFilesMain();toast('Moved to '+nf.name)}}});
  showMenu(anchor,items);
}
function toggleFileStar(f){
  SET.starredFiles=SET.starredFiles||{};
  if(SET.starredFiles[f.blobId])delete SET.starredFiles[f.blobId];else SET.starredFiles[f.blobId]=true;
  saveSettings();paintFilesTypes();paintFilesCollections();paintFilesMain();
}
function collectFileMenu(f,anchor){
  const items=[];
  for(const c of (SET.fileCollections||[])){
    const on=(c.blobIds||[]).includes(f.blobId);
    items.push({label:c.name,check:on,keepOpen:true,onclick:()=>{
      c.blobIds=c.blobIds||[];
      if(on)c.blobIds=c.blobIds.filter(x=>x!==f.blobId);else c.blobIds.push(f.blobId);
      saveSettings();paintFilesCollections();paintFilesMain();
    }});
  }
  if(items.length)items.push('—');
  items.push({label:'+ New collection',onclick:()=>{
    const n=prompt('Collection name');if(!n)return;
    SET.fileCollections=(SET.fileCollections||[]).concat({id:uid('c'),name:n,blobIds:[f.blobId]});
    saveSettings();paintFilesCollections();paintFilesMain();toast('Added to new collection');
  }});
  showMenu(anchor,items);
}
function downloadFile(f){
  const a=document.createElement('a');a.href=downloadUrl(f.blobId,f.name);a.download=f.name;a.click();
}
async function sendFileAgain(f){
  openCompose();
  await sleep(60);
  S.cpAtts.push({blobId:f.blobId,name:f.name,type:f.type,size:f.size});
  renderCpAtts();S.cpDirty=true;
  toast('Attached "'+f.name+'" — pick a recipient and hit send');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function paintFilesUsage(){
  const bar=$('fv-usage');bar.innerHTML='';
  const list=S.filesIndex||[];
  const total=list.reduce((s,f)=>s+(f.size||0),0);
  const byKind={};for(const f of list)byKind[f.kind]=(byKind[f.kind]||0)+(f.size||0);
  const segs=Object.entries(byKind).sort((a,b)=>b[1]-a[1]);
  const g=document.createElement('div');g.className='fv-bar';
  for(const [k,s] of segs){
    const t=FILE_TYPES.find(x=>x.key===k)||FILE_TYPES[FILE_TYPES.length-1];
    const w=total?(s/total*100):0;
    const seg=document.createElement('span');seg.className='fv-bar-seg';seg.style.width=w+'%';seg.style.background=`hsl(${t.hue} 62% 55%)`;seg.setAttribute('data-tip',`${t.label}: ${fmtSize(s)}`);
    g.appendChild(seg);
  }
  const cap=document.createElement('div');cap.className='fv-bar-cap';cap.innerHTML=`<b>${fmtSize(total)}</b> across ${list.length} file${list.length===1?'':'s'}`;
  bar.appendChild(g);bar.appendChild(cap);
}
function openFile(f){
  if(f.kind==='image'){
    $('fv-lb-name').textContent=f.name;
    $('fv-lb-body').innerHTML='';
    const im=document.createElement('img');im.src=downloadUrl(f.blobId,f.name);im.className='fv-lb-img';
    $('fv-lb-body').appendChild(im);
    $('fv-lb-foot').innerHTML='';
    const foot=$('fv-lb-foot');
    foot.appendChild(mkLbBtn('Download',()=>downloadFile(f)));
    foot.appendChild(mkLbBtn('Send again',()=>sendFileAgain(f)));
    foot.appendChild(mkLbBtn('Open source mail',()=>{$('fv-lightbox').classList.add('hidden');openThread(f.threadId).catch(err)}));
    $('fv-lightbox').classList.remove('hidden');
    return;
  }
  window.open(downloadUrl(f.blobId,f.name),'_blank');
}
function mkLbBtn(t,fn){const b=document.createElement('button');b.className='btn-ghost';b.textContent=t;b.onclick=fn;return b}
function armFilesUi(){
  const setViewMode=(m)=>{
    SET.filesView=m;saveSettings();
    for(const k of['grid','list','timeline'])$('fv-'+k).classList.toggle('active',k===m);
    paintFilesMain();
  };
  $('fv-grid').onclick=()=>setViewMode('grid');
  $('fv-list').onclick=()=>setViewMode('list');
  $('fv-timeline').onclick=()=>setViewMode('timeline');
  $('fv-sort').onchange=()=>{SET.filesSort=$('fv-sort').value;saveSettings();paintFilesMain()};
  $('fv-search').addEventListener('input',()=>{clearTimeout(S.filesSearchT);S.filesSearchT=setTimeout(paintFilesMain,220)});
  $('fv-refresh').onclick=()=>ensureFilesIndex(true).then(()=>{paintFilesTypes();paintFilesMain();toast('Files re-scanned')}).catch(err);
  $('fv-add-col').onclick=()=>{const n=prompt('Collection name');if(!n)return;
    SET.fileCollections=(SET.fileCollections||[]).concat({id:uid('c'),name:n,blobIds:[]});saveSettings();paintFilesCollections()};
  $('fv-lb-close').onclick=()=>$('fv-lightbox').classList.add('hidden');
  $('fv-lightbox').querySelector('.fv-lb-back').onclick=()=>$('fv-lightbox').classList.add('hidden');
  $('fv-props-close').onclick=()=>$('fv-props').classList.add('hidden');
  $('fv-props').querySelector('.modal-back').onclick=()=>$('fv-props').classList.add('hidden');
  $('fv-import-input').onchange=e=>{const fs=[...e.target.files||[]];e.target.value='';importFromDevice(fs).catch(err)};
  $('fv-new-folder').onclick=()=>{if(createFolder(SET.currentFolder||''))paintFolderTree(),paintFilesMain()};
  $('fv-back').onclick=historyBack;
  $('fv-fwd').onclick=historyForward;
  $('fv-up').onclick=historyUp;
  $('fv-icon-range').oninput=e=>{const map={1:'xs',2:'sm',3:'md',4:'lg',5:'xl'};SET.filesIconSize=map[e.target.value]||'md';saveSettings();paintFilesMain()};
  $('fv-crumb-edit').onclick=()=>toggleAddressBar();
  $('fv-address').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();navigateByPath($('fv-address').value);toggleAddressBar()}else if(e.key==='Escape')toggleAddressBar()});
  armFilesKeys();
  const fv=$('files-view');
  ['dragover','dragenter'].forEach(t=>fv.addEventListener(t,e=>{e.preventDefault();fv.classList.add('fv-dropping')}));
  ['dragleave','drop'].forEach(t=>fv.addEventListener(t,e=>{if(t==='drop')e.preventDefault();fv.classList.remove('fv-dropping')}));
  fv.addEventListener('drop',e=>{const fs=[...e.dataTransfer.files||[]];if(fs.length)importFromDevice(fs).catch(err)});
}
function showFilesTab(){
  $('fv-grid').classList.toggle('active',SET.filesView==='grid');
  $('fv-list').classList.toggle('active',SET.filesView==='list');
  $('fv-timeline').classList.toggle('active',SET.filesView==='timeline');
}

/* ---------- notifications + live ---------- */
function maybeNotify(){
  if(!SET.notif||!('Notification' in window)||Notification.permission!=='granted')return;
  if(S.view.type!=='role'||S.view.key!=='inbox')return;
  const ids=new Set(S.list.map(e=>e.id));
  if(S.lastInboxIds){
    for(const e of S.list){
      if(!S.lastInboxIds.has(e.id)&&!(e.keywords&&e.keywords.$seen)){
        const who=(e.from&&e.from[0])||{};
        new Notification(who.name||who.email||'New mail',{body:(e.subject||'')+' — '+(e.preview||''),tag:e.id});
      }}}
  S.lastInboxIds=ids;
}
function startLive(){
  try{
    if(S.es)S.es.close();
    S.es=new EventSource(jmapUrl(`/jmap/eventsource?types=Email,Mailbox&ping=60&access_token=${encodeURIComponent(atob(S.token))}`));
    S.es.onmessage=()=>refreshSoft();
    S.es.addEventListener('state',()=>refreshSoft());
  }catch(_){}
  clearInterval(S.pollTimer);
  S.pollTimer=setInterval(refreshSoft,60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshSoft()});
}
let refreshing=false;
async function refreshSoft(){
  if(focusActive())return;
  if(refreshing||S.openThreadId||!$('compose').classList.contains('hidden'))return;
  refreshing=true;
  try{await refreshBoxes();await loadList(true);maybeNotify()}catch(_){}finally{refreshing=false}
}

/* ---------- keyboard ---------- */
const HELP=[
  ['Navigation',[['j / k','Newer / older conversation'],['Enter / o','Open'],['u','Back to list'],['g then i','Go to Inbox'],['g then s','Go to Starred'],['g then t','Go to Sent'],['g then d','Go to Drafts'],['g then a','Go to Archive'],['/','Search'],['?','This help']]],
  ['Actions',[['c','Compose'],['x','Select conversation'],['s','Star'],['b','Snooze'],['+ / -','Important / not'],['e','Archive'],['#','Delete'],['!','Report spam'],['Shift+i','Mark read'],['Shift+u','Mark unread'],['l','Label as'],['v','Move to'],['z','Undo (via toast)'],['r','Reply'],['a','Reply all'],['f','Forward'],['Ctrl+Enter','Send']]]];
function renderHelp(){
  const w=$('help-cols');w.innerHTML='';
  for(const [title,rows] of HELP){
    const col=document.createElement('div');col.className='help-col';
    col.innerHTML=`<h4>${title}</h4>`+rows.map(([k,d])=>`<div class="help-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('');
    w.appendChild(col);
  }
}
function cursorEmail(){return S.cursor>=0?S.list[S.cursor]:null}
function moveCursor(d){
  if(!S.list.length)return;
  S.cursor=Math.max(0,Math.min(S.list.length-1,(S.cursor<0?(d>0?-1:0):S.cursor)+d));
  renderRows();
  const el=document.querySelector('.row.cursor');if(el)el.scrollIntoView({block:'nearest'});
}
function keyTargets(){
  const inList=!$('list-view').classList.contains('hidden');
  const tids=S.sel.size?selThreads():(S.openThreadId?[S.openThreadId]:(cursorEmail()?[cursorEmail().threadId]:[]));
  return{inList,tids};
}
function lastOpenMsg(){
  const tid=S.openThreadId;if(!tid)return null;
  const ids=S.threadEmails[tid]||[];
  return S.emailCache[ids[ids.length-1]]||null;
}
document.addEventListener('keydown',e=>{
  const tag=(e.target.tagName||'').toLowerCase();
  const typing=tag==='input'||tag==='textarea'||tag==='select'||e.target.isContentEditable;
  if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!$('compose').classList.contains('hidden')){e.preventDefault();sendNowRequest();return}
  if(e.key==='Escape'){
    hideMenu();
    if(!$('help').classList.contains('hidden'))return $('help').classList.add('hidden');
    if(!$('adv-search').classList.contains('hidden'))return $('adv-search').classList.add('hidden');
    if(!$('settings').classList.contains('hidden'))return $('settings').classList.add('hidden');
    if(!$('compose').classList.contains('hidden'))return closeCompose(true);
    if(typing)e.target.blur();
    return;
  }
  if(typing)return;
  const{tids}=keyTargets();
  const now=Date.now();
  if(S.chordKey==='g'&&now-S.chordAt<1200){
    S.chordKey=null;
    const map={i:'inbox',s:'starred',t:'sent',d:'drafts',a:'archive'};
    if(map[e.key]){e.preventDefault();setView('role',map[e.key]);return}
  }
  switch(e.key){
    case 'g':S.chordKey='g';S.chordAt=now;return;
    case 'c':e.preventDefault();openCompose();return;
    case '/':e.preventDefault();$('search').focus();$('search').select();return;
    case '?':e.preventDefault();renderHelp();$('help').classList.remove('hidden');return;
    case 'j':moveCursor(1);return;
    case 'k':moveCursor(-1);return;
    case 'o':case 'Enter':{const ce=cursorEmail();if(ce&&!S.openThreadId)openRow(ce);return}
    case 'u':if(S.openThreadId)showList();else refreshSoft();return;
    case 'x':{const ce=cursorEmail();if(ce)toggleSel(ce.id,false,S.cursor);return}
    case 's':{const m=S.openThreadId?lastOpenMsg():cursorEmail();if(m)toggleStar(m).catch(err);return}
    case 'e':if(tids.length)bulkAct('archive',tids).catch(err);return;
    case '#':if(tids.length)bulkAct('trash',tids).catch(err);return;
    case '!':if(tids.length)bulkAct('spam',tids).catch(err);return;
    case 'I':if(tids.length)setThreadsSeen(tids,true).catch(err);return;
    case 'U':if(tids.length){setThreadsSeen(tids,false).then(()=>{if(S.openThreadId)showList()}).catch(err)}return;
    case 'b':{const a=S.openThreadId?$('th-snooze'):$('bk-snooze');if(tids.length)snoozeMenu(a,tids);return}
    case '+':case '=':if(tids.length)setImportant(tids,true).catch(err);return;
    case '-':if(tids.length)setImportant(tids,false).catch(err);return;
    case 'l':{const a=S.openThreadId?$('th-label'):$('bk-label');if(tids.length)labelMenu(a,tids);return}
    case 'v':{const a=S.openThreadId?$('th-move'):$('bk-move');if(tids.length)moveMenu(a,tids);return}
    case 'z':{const b=$('toast-act');if(!b.classList.contains('hidden'))b.click();return}
    case 'r':{const m=lastOpenMsg();if(m)openCompose('reply',m);return}
    case 'a':{const m=lastOpenMsg();if(m)openCompose('replyall',m);return}
    case 'f':{const m=lastOpenMsg();if(m)openCompose('forward',m);return}
  }
});

/* ---------- bindings ---------- */
function bind(){
  $('login-form').onsubmit=async e=>{
    e.preventDefault();$('li-err').textContent='';$('li-btn').disabled=true;
    try{await login($('li-user').value.trim(),$('li-pass').value)}
    catch(x){$('li-err').textContent=x.message}
    $('li-btn').disabled=false;
  };
  $('account-chip').onclick=e=>{e.stopPropagation();$('profile-menu').classList.contains('hidden')?openProfileMenu():closeProfileMenu()};
  document.addEventListener('click',e=>{
    const pm=$('profile-menu');
    if(pm.classList.contains('hidden'))return;
    if(pm.contains(e.target)||$('account-chip').contains(e.target))return;
    closeProfileMenu();
  });
  $('pm-manage').onclick=()=>{closeProfileMenu();openProfile()};
  $('pm-settings').onclick=()=>{closeProfileMenu();openSettings()};
  $('pm-status').onclick=()=>{closeProfileMenu();openProfile()};
  $('pm-signout').onclick=()=>{if(confirm('Sign out of VF Mail?')){sessionStorage.clear();location.reload()}};

  $('prof-close').onclick=()=>$('profile-modal').classList.add('hidden');
  $('prof-cancel').onclick=()=>$('profile-modal').classList.add('hidden');
  $('profile-modal').querySelector('.modal-back').onclick=()=>$('profile-modal').classList.add('hidden');
  $('prof-save').onclick=()=>saveProfile().catch(err);
  $('prof-upload').onclick=()=>$('prof-file').click();
  $('prof-photo-clear').onclick=()=>{SET.photo='';$('prof-photo-preview').style.backgroundImage='';$('prof-photo-preview').textContent=initials(SET.displayName,S.user||'?');updateAccountAvatar()};
  $('prof-file').onchange=async()=>{
    const f=$('prof-file').files[0];if(!f)return;
    const url=await readImageAsDataURL(f,320);
    SET.photo=url;$('prof-photo-preview').style.backgroundImage=`url("${url}")`;$('prof-photo-preview').textContent='';
    updateAccountAvatar();
  };
  $('prof-pronouns').onchange=e=>$('prof-pronouns-custom').classList.toggle('hidden',e.target.value!=='custom');
  document.querySelectorAll('#prof-status-grid .prof-stat').forEach(b=>{
    b.onclick=()=>{document.querySelectorAll('#prof-status-grid .prof-stat').forEach(x=>x.classList.remove('on'));b.classList.add('on')};
  });
  document.querySelectorAll('#sp-tabs .sp-tab').forEach(b=>b.onclick=()=>showSpTab(b.dataset.tab));
  $('st-cancel').onclick=()=>$('settings').classList.add('hidden');
  $('tb-menu').onclick=()=>toggleRail();
  armRailDrag();
  document.addEventListener('scroll',e=>{if(menuOpen()&&!$('menu').contains(e.target))hideMenu()},true);
  $('tb-refresh').onclick=()=>refreshSoft();
  $('tb-summarize').onclick=()=>runSummarize();
  $('tb-settings').onclick=()=>openSettings();
  $('st-close').onclick=()=>$('settings').classList.add('hidden');
  $('st-save').onclick=()=>saveSettingsSheet().catch(err);
  $('btn-compose').onclick=()=>openCompose();
  $('btn-newlabel').onclick=()=>newLabel();
  /* search */
  $('search').addEventListener('keydown',e=>{
    if(e.key==='Enter'){const q=$('search').value.trim();
      if(q)setView('search','q',q);else setView('role','inbox');
      $('search').blur()}});
  $('search').addEventListener('input',()=>$('search-clear').classList.toggle('hidden',!$('search').value));
  $('search-clear').onclick=()=>{$('search').value='';$('search-clear').classList.add('hidden');setView('role','inbox')};
  $('search-adv').onclick=()=>{
    const p=$('adv-search');p.classList.toggle('hidden');
    if(!p.classList.contains('hidden')){
      const sel=$('as-in');sel.innerHTML='<option value="">All mail</option>';
      for(const d of RAIL_DEF)if(d.key!=='starred'&&S.byRole[d.key])sel.add(new Option(d.label,d.label.toLowerCase()));
      for(const b of S.labels)sel.add(new Option(b.name,b.name.toLowerCase()));
    }};
  $('as-close').onclick=()=>$('adv-search').classList.add('hidden');
  $('as-go').onclick=()=>{
    const parts=[];
    const v=id=>$(id).value.trim();
    if(v('as-from'))parts.push('from:'+quoteQ(v('as-from')));
    if(v('as-to'))parts.push('to:'+quoteQ(v('as-to')));
    if(v('as-subject'))parts.push('subject:'+quoteQ(v('as-subject')));
    if(v('as-has'))parts.push(v('as-has'));
    if(v('as-not'))parts.push('-subject:'+quoteQ(v('as-not')));
    if(v('as-in'))parts.push('in:'+quoteQ(v('as-in')));
    if(v('as-after'))parts.push('after:'+v('as-after'));
    if(v('as-before'))parts.push('before:'+v('as-before'));
    if($('as-att').checked)parts.push('has:attachment');
    const q=parts.join(' ');if(!q)return;
    $('search').value=q;$('search-clear').classList.remove('hidden');
    $('adv-search').classList.add('hidden');
    setView('search','q',q);
  };
  /* list toolbar */
  $('sel-master').onclick=()=>{S.sel.size?selectWhere(()=>false):selectWhere(()=>true)};
  $('sel-caret').onclick=e=>{e.stopPropagation();showMenu($('sel-caret'),[
    {label:'All',onclick:()=>selectWhere(()=>true)},
    {label:'None',onclick:()=>selectWhere(()=>false)},
    {label:'Read',onclick:()=>selectWhere(x=>x.keywords&&x.keywords.$seen)},
    {label:'Unread',onclick:()=>selectWhere(x=>!(x.keywords&&x.keywords.$seen))},
    {label:'Starred',onclick:()=>selectWhere(x=>x.keywords&&x.keywords.$flagged)},
    {label:'Unstarred',onclick:()=>selectWhere(x=>!(x.keywords&&x.keywords.$flagged))}])};
  $('bk-archive').onclick=()=>bulkAct('archive').catch(err);
  $('bk-spam').onclick=()=>bulkAct('spam').catch(err);
  $('bk-trash').onclick=()=>bulkAct('trash').catch(err);
  $('bk-read').onclick=()=>setThreadsSeen(null,true).then(()=>{S.sel.clear()}).catch(err);
  $('bk-unread').onclick=()=>setThreadsSeen(null,false).then(()=>{S.sel.clear()}).catch(err);
  $('bk-label').onclick=e=>{e.stopPropagation();labelMenu($('bk-label'))};
  $('bk-move').onclick=e=>{e.stopPropagation();moveMenu($('bk-move'))};
  $('bk-snooze').onclick=e=>{e.stopPropagation();snoozeMenu($('bk-snooze'))};
  $('bk-important').onclick=()=>{
    const first=S.emailCache[[...S.sel][0]]||{};
    setImportant(null,!(first.keywords&&first.keywords.$important)).catch(err)};
  $('btn-more').onclick=()=>{S.pos=S.list.length;loadList(false).catch(err)};
  /* thread toolbar */
  $('th-back').onclick=()=>showList();
  $('th-archive').onclick=()=>bulkAct('archive',[S.openThreadId]).catch(err);
  $('th-spam').onclick=()=>bulkAct('spam',[S.openThreadId]).catch(err);
  $('th-trash').onclick=()=>bulkAct('trash',[S.openThreadId]).catch(err);
  $('th-unread').onclick=()=>setThreadsSeen([S.openThreadId],false).then(showList).catch(err);
  $('th-label').onclick=e=>{e.stopPropagation();labelMenu($('th-label'),[S.openThreadId])};
  $('th-move').onclick=e=>{e.stopPropagation();moveMenu($('th-move'),[S.openThreadId])};
  $('th-snooze').onclick=e=>{e.stopPropagation();snoozeMenu($('th-snooze'),[S.openThreadId])};
  /* compose chrome */
  $('cp-close').onclick=()=>closeCompose(true);
  $('cp-min').onclick=()=>$('compose').classList.toggle('min');
  $('cp-max').onclick=()=>$('compose').classList.toggle('max');
  $('cp-head').ondblclick=()=>$('compose').classList.toggle('min');
  $('cp-send').onclick=()=>sendNowRequest();
  $('cp-send-caret').onclick=e=>{e.stopPropagation();scheduleMenu($('cp-send-caret'))};
  $('cp-templates').onclick=e=>{e.stopPropagation();openTemplatesMenu($('cp-templates'))};
  $('cp-quick-attach').onclick=e=>{e.stopPropagation();openQuickAttachPicker($('cp-quick-attach'))};

  /* filter modal */
  $('filter-close').onclick=()=>$('filter-modal').classList.add('hidden');
  $('filter-modal').querySelector('.modal-back').onclick=()=>$('filter-modal').classList.add('hidden');
  /* alias modal — click-outside close */
  $('alias-modal').querySelector('.modal-back').onclick=()=>$('alias-modal').classList.add('hidden');

  /* custom tooltips */
  armTooltips();
  $('cp-discard').onclick=()=>discardDraft().catch(err);
  $('cp-attach').onclick=()=>$('cp-file').click();
  $('cp-file').onchange=()=>{uploadFiles([...$('cp-file').files]).catch(err);$('cp-file').value=''};
  $('cp-showcc').onclick=()=>{$('cp-cc-row').classList.remove('hidden');$('cp-cc').focus()};
  $('cp-showbcc').onclick=()=>{$('cp-bcc-row').classList.remove('hidden');$('cp-bcc').focus()};
  for(const el of ['cp-to','cp-cc','cp-bcc','cp-subject'])$(el).addEventListener('input',()=>{S.cpDirty=true});
  $('cp-body').addEventListener('input',()=>{S.cpDirty=true});
  $('cp-body').addEventListener('paste',e=>{
    const items=[...(e.clipboardData||{}).items||[]].filter(i=>i.kind==='file');
    if(items.length){e.preventDefault();uploadFiles(items.map(i=>i.getAsFile()).filter(Boolean)).catch(err)}});
  document.querySelectorAll('#cp-toolbar button').forEach(b=>{
    b.onmousedown=e=>e.preventDefault();
    b.onclick=()=>{
      const cmd=b.dataset.cmd;
      if(cmd==='createLink'){const u=prompt('Link URL','https://');if(u)document.execCommand('createLink',false,u)}
      else if(cmd==='formatBlockquote')document.execCommand('formatBlock',false,'blockquote');
      else document.execCommand(cmd,false,null);
      S.cpDirty=true;$('cp-body').focus();
    }});
  window.addEventListener('dragover',e=>{if(!$('compose').classList.contains('hidden'))e.preventDefault()});
  window.addEventListener('drop',e=>{
    if($('compose').classList.contains('hidden'))return;
    e.preventDefault();
    const fs=[...e.dataTransfer.files||[]];if(fs.length)uploadFiles(fs).catch(err)});
  $('help-close').onclick=()=>$('help').classList.add('hidden');
  window.addEventListener('beforeunload',()=>{
    if(S.pendingSend){clearTimeout(S.pendingSend.timer);
      navigator.sendBeacon&&doSend(S.pendingSend.obj,S.pendingSend.oldDraft).catch(()=>{})}});
}
const quoteQ=v=>/\s/.test(v)?'"'+v.replace(/"/g,'')+'"':v;

/* ---------- public API for modules (dm.js etc.) ---------- */
window.VfMailAPI = {
  get state(){ return S },
  get identity(){ return S.identity },
  jmap, jmapUrl, esc, hueFor,
  railExtensions: [],
  onStateChange(cb){ (window.__vfm_state_cbs__=window.__vfm_state_cbs__||[]).push(cb) },
  fireStateChange(){ (window.__vfm_state_cbs__||[]).forEach(fn=>{try{fn()}catch(_){}}) },
  setActiveRail(key){ document.querySelectorAll('#rail-list .rail-row').forEach(b=>b.classList.toggle('active',b.dataset.key===key)) },
  toast: typeof toast==='function'?toast:()=>{},
  IS_TAURI,
};
/* wrap renderRail so modules can inject extra rail buttons after it paints */
if(typeof renderRail==='function'){
  const _origRenderRail=renderRail;
  renderRail=function(){_origRenderRail.apply(this,arguments);window.VfMailAPI.railExtensions.forEach(fn=>{try{fn(document.getElementById('rail-list'))}catch(_){}})};
}
/* wrap setView so modules can hook navigation (e.g. hide their custom views) */
if(typeof setView==='function'){
  const _origSetView=setView;
  setView=function(type,key){const dv=document.getElementById('dm-view');if(dv)dv.classList.add('hidden');const lv=document.getElementById('list-view');if(lv)lv.classList.remove('hidden');return _origSetView.apply(this,arguments)};
}
if(typeof refreshSoft==='function'){
  const _origRefresh=refreshSoft;
  refreshSoft=async function(){await _origRefresh.apply(this,arguments);window.VfMailAPI.fireStateChange()};
}

/* ---------- init ---------- */
bind();
async function vaultAutoLogin(){
  try{
    const inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
    if(!inv)return false;
    const c=await inv('mail_get_creds');
    if(!c||!c.address||!c.password)return false;
    await login(c.address,c.password);
    return true;
  }catch(_){return false}
}
function revealLoginIfWeb(){ if(!IS_TAURI) $('login').classList.remove('hidden') }
if(IS_TAURI){
  document.addEventListener('vfmail:vault-unlocked',async()=>{
    if(S.token){try{await resume();return}catch(_){sessionStorage.clear()}}
    const ok=await vaultAutoLogin();
    if(!ok) document.dispatchEvent(new CustomEvent('vfmail:need-mail-creds'));
  });
}else{
  if(S.token){resume().catch(()=>{sessionStorage.clear();revealLoginIfWeb()})}
  else revealLoginIfWeb();
}
