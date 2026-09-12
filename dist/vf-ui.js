/* ===========================================================================
 * VF·UI — shared VF Mail UI kit
 *   Reusable primitives so we don't recreate the same building blocks.
 *   Add new primitives here; consume as window.VfUi.<name>.
 *
 * Included via <script src="/vf-ui.js"></script> BEFORE app.js.
 * ---------------------------------------------------------------------------
 * Currently ships:
 *   - VfUi.mountDotRail(el)        white-glow silock scroll rail
 *   - VfUi.armTooltips()           delegate hover tooltips (data-tip or title)
 *   - VfUi.showTip(el, txt)        show tip on demand
 *   - VfUi.hideTip()               hide it
 *   - VfUi.uid(prefix)             short unique id
 *   - VfUi.esc(s)                  html escape
 *   - VfUi.fmtSize(n)              1234 → "1.2 KB"
 *   - VfUi.fmtDate(iso)            short date
 *   - VfUi.debounce(fn, ms)
 *   - VfUi.hueFor(str)             stable hue 0-360 for a string
 * =========================================================================== */
(function(w){
'use strict';
const $=id=>document.getElementById(id);

/* ---------- dot-rail scroll (S◉LOCK house standard) ---------- */
function mountDotRail(el){
  if(!el)return;
  el.dataset.dotrail='1';
  if(el._dotrailWired){el._dotrailPaint&&el._dotrailPaint();return}
  el._dotrailWired=true;
  const findOrMake=()=>{
    let c=null;
    for(const ch of el.children)if(ch.classList&&ch.classList.contains('dotrail')){c=ch;break}
    if(!c){c=document.createElement('canvas');c.className='dotrail';el.appendChild(c)}
    return c;
  };
  let trail=[];let raf=0;
  const paint=()=>{
    const c=findOrMake();
    const ctx=c.getContext('2d');
    const dpr=w.devicePixelRatio||1;
    const box=el.getBoundingClientRect();
    if(box.height<20)return;
    c.width=Math.round(10*dpr);c.height=Math.round(box.height*dpr);
    c.style.width='10px';c.style.height=box.height+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,10,box.height);
    if(el.scrollHeight<=el.clientHeight+2)return;
    const ratio=el.scrollTop/(el.scrollHeight-el.clientHeight);
    const y=8+ratio*(box.height-16);
    /* trailing stream — head bright, tail fades to nothing */
    trail.push(y);if(trail.length>26)trail.shift();
    for(let i=0;i<trail.length-1;i++){
      const a=trail[i],b=trail[i+1];
      const rel=i/(trail.length-1);
      const alpha=Math.pow(rel,1.8)*0.75;
      ctx.strokeStyle='rgba(255,255,255,'+alpha.toFixed(3)+')';
      ctx.lineWidth=1.2+rel*1.1;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(5,a);ctx.lineTo(5,b);ctx.stroke();
    }
    /* dark contrast halo so the white dot reads on light surfaces */
    const dh=ctx.createRadialGradient(5,y,0,5,y,8);
    dh.addColorStop(0,'rgba(29,29,31,0)');
    dh.addColorStop(.55,'rgba(29,29,31,.14)');
    dh.addColorStop(1,'rgba(29,29,31,0)');
    ctx.fillStyle=dh;ctx.beginPath();ctx.arc(5,y,8,0,Math.PI*2);ctx.fill();
    /* soft white glow */
    const g=ctx.createRadialGradient(5,y,0,5,y,7);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.4,'rgba(255,255,255,.7)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(5,y,7,0,Math.PI*2);ctx.fill();
    /* core dot */
    ctx.fillStyle='rgba(255,255,255,1)';
    ctx.beginPath();ctx.arc(5,y,2.4,0,Math.PI*2);ctx.fill();
  };
  const schedule=()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;paint()})};
  el._dotrailPaint=paint;
  el.addEventListener('scroll',schedule,{passive:true});
  new ResizeObserver(schedule).observe(el);
  /* trail decay while idle */
  let decay=setInterval(()=>{if(trail.length){trail.shift();schedule()}else clearInterval(decay)},220);
  el.addEventListener('scroll',()=>{if(!decay)decay=setInterval(()=>{if(trail.length){trail.shift();schedule()}else clearInterval(decay)},220)});
  paint();
}

/* ---------- tooltips ---------- */
let tipT=null,tipCur=null,armed=false;
function armTooltips(){
  if(armed)return;armed=true;
  document.addEventListener('mouseover',e=>{
    const el=e.target.closest('[data-tip],[title]');
    if(!el||el===tipCur)return;
    const txt=el.getAttribute('data-tip')||el.getAttribute('title');
    if(!txt)return;
    if(el.getAttribute('title')){el.setAttribute('data-tip',el.getAttribute('title'));el.removeAttribute('title')}
    tipCur=el;clearTimeout(tipT);
    tipT=setTimeout(()=>showTip(el,txt),250);
  });
  document.addEventListener('mouseout',e=>{
    if(!tipCur||(e.relatedTarget&&tipCur.contains(e.relatedTarget)))return;
    clearTimeout(tipT);tipCur=null;hideTip();
  });
  document.addEventListener('mousedown',()=>{clearTimeout(tipT);hideTip()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTip()});
  document.addEventListener('scroll',()=>hideTip(),true);
}
function showTip(el,txt){
  const t=$('tip');if(!t)return;
  $('tip-txt').textContent=txt;
  t.classList.remove('hidden');
  const r=el.getBoundingClientRect();
  const tw=t.offsetWidth,th=t.offsetHeight;
  let x=r.left+r.width/2-tw/2;
  let y=r.bottom+9,pos='bottom';
  if(y+th>w.innerHeight-8){y=r.top-th-9;pos='top'}
  x=Math.max(8,Math.min(w.innerWidth-tw-8,x));
  t.style.left=x+'px';t.style.top=y+'px';t.setAttribute('data-arrow',pos);
}
function hideTip(){const t=$('tip');if(t)t.classList.add('hidden')}

/* ---------- small utilities ---------- */
const uid=p=>(p||'x')+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtSize=n=>!n?'0 B':n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';
const fmtDate=iso=>{const d=new Date(iso),now=new Date();
  if(isNaN(d))return '';
  if(d.toDateString()===now.toDateString())return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(d.getFullYear()===now.getFullYear())return d.toLocaleDateString([],{day:'numeric',month:'short'});
  return d.toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'})};
function debounce(fn,ms){let t=0;return function(){clearTimeout(t);const a=arguments,c=this;t=setTimeout(()=>fn.apply(c,a),ms||180)}}
function hueFor(s){let h=0;s=String(s||'');for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))%360;return h}

w.VfUi={mountDotRail,armTooltips,showTip,hideTip,uid,esc,fmtSize,fmtDate,debounce,hueFor};
})(window);
