const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const state = { cases: [], results: [], key: null, selected: null, mode: 'case', favoritesOnly: false,
  favorites: new Set(), query: '', filters: { year: '', group: '', univ: '', form: '' }, limit: 60,
  pdf: null, loadingTask: null, blob: null, page: 1, zoom: 1, generation: 0, renderSerial: 0, renderTask: null, tab: 'info', openAnswers: new Set() };
let meta, pdfModule, toastTimer, resizeTimer;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = (text) => String(text ?? '').normalize('NFKC').toLocaleLowerCase('ko');
const terms = () => norm(state.query).trim().split(/\s+/).filter(Boolean);
const textOf = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(textOf).join(' ') : value && typeof value === 'object' ? Object.values(value).map(textOf).join(' ') : '';
const univAlias = (c) => c.univ.replace(/대(?=\(|$)/g,'대학교');
const fullText = (c) => [c.year,c.group,c.univ,univAlias(c),c.dept,c.admission,textOf(c.interview),c.intro_note,textOf(c.questions),c.etc].join(' ');
const questionText = (q) => [q.q,q.a,textOf(q.followups)].join(' ');
function highlighted(text) {
  text = String(text ?? '');
  const tokens = [...new Set(terms())].sort((a,b)=>b.length-a.length);
  if (!tokens.length) return escape(text);
  const re = new RegExp(tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  let out = '', last = 0;
  for (const m of text.matchAll(re)) { out += escape(text.slice(last,m.index)) + '<mark>' + escape(m[0]) + '</mark>'; last=m.index+m[0].length; }
  return out + escape(text.slice(last));
}
function snippet(c, question) {
  const ts = terms();
  const candidates = question ? [question.q,...(question.followups||[]).map(f=>f.q),question.a,...(question.followups||[]).map(f=>f.a)] : c.questions.flatMap(q => [q.q,q.a,...(q.followups||[]).flatMap(f=>[f.q,f.a])]);
  candidates.push(c.etc || '',c.intro_note || '',textOf(c.interview));
  const text = candidates.find(t => ts.length && ts.some(term=>norm(t).includes(term))) || candidates.find(Boolean) || '';
  let start = 0;
  if (ts.length) { const found = ts.map(t=>norm(text).indexOf(t)).filter(i=>i>=0); if(found.length) start=Math.max(0,Math.min(...found)-32); }
  return (start?'…':'') + text.slice(start,start+135) + (text.length>start+135?'…':'');
}
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,3200); }
function loadFavorites() { try { state.favorites=new Set(JSON.parse(localStorage.getItem('jb-favorites-v1')||'[]')); } catch { state.favorites=new Set(); } }
function saveFavorites() { try { localStorage.setItem('jb-favorites-v1',JSON.stringify([...state.favorites])); } catch { toast('이 브라우저에서는 즐겨찾기를 저장할 수 없습니다.'); } }
function toggleFavorite(id) { state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id); saveFavorites(); applyFilters(false); updateFavorite(); }
function updateFavorite() { $('favorite-count').textContent=state.favorites.size; if(state.selected) { const yes=state.favorites.has(state.selected.id); $('detail-favorite').textContent=yes?'★':'☆'; $('detail-favorite').setAttribute('aria-pressed',yes); $('detail-favorite').setAttribute('aria-label',yes?'즐겨찾기 해제':'즐겨찾기 추가'); } }
function b64bytes(value) { return Uint8Array.from(atob(value), c=>c.charCodeAt(0)); }
function bytesb64(value) { return btoa(String.fromCharCode(...new Uint8Array(value))); }
async function getMeta() {
  if(!window.crypto?.subtle) throw new Error('HTTPS 주소 또는 localhost에서 앱을 열어 주세요.');
  const response=await fetch('data/meta.json',{cache:'no-cache'});
  if(!response.ok) throw new Error('자료 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const data=await response.json();
  if(data.format!=='JBIS1'||data.iterations!==250000) throw new Error('지원하지 않는 자료 형식입니다.');
  return data;
}
async function decryptFile(key,url,label) {
  const response=await fetch(url,{cache:'no-cache'});
  if(!response.ok) throw new Error('자료를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(dec.decode(bytes.slice(0,5))!=='JBIS1') throw new Error('암호화 자료 형식이 올바르지 않습니다.');
  return crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(5,17),additionalData:enc.encode('JBIS1:'+label)},key,bytes.slice(17));
}
async function unlock(key) {
  const payload=JSON.parse(dec.decode(await decryptFile(key,'data/cases.bin','cases')));
  if(payload.schema_version!==1 || !Array.isArray(payload.cases)) throw new Error('자료 구조를 확인해 주세요.');
  state.key=key;
  state.cases=payload.cases.map(c=>({...c,_search:norm(fullText(c))}));
  loadFavorites();
  buildFilters(); restoreHash();
  $('gate').hidden=true; $('app').hidden=false; $('password').value='';
  $('library-count').textContent=`${state.cases.length.toLocaleString()}개 사례 · ${new Set(state.cases.map(c=>c.univ)).size}개 대학`;
  const indexed=state.cases.filter(c=>c.indexed).length;
  $('coverage').textContent=`원본 PDF ${state.cases.length.toLocaleString()}건 · 질문 본문 검색 ${indexed}건`;
  const wanted=new URLSearchParams(location.hash.slice(1)).get('case');
  applyFilters(false);
  if(wanted) { const c=state.cases.find(c=>c.id===wanted); if(c) selectCase(c.id); else toast('공유한 사례를 현재 자료에서 찾을 수 없습니다.'); }
  else $('query').focus({preventScroll:true});
}
$('login').addEventListener('submit',async(event)=>{
  event.preventDefault(); $('login-button').disabled=true; $('login-status').textContent='자료를 안전하게 여는 중입니다…';
  try {
    meta=await getMeta();
    const material=await crypto.subtle.importKey('raw',enc.encode($('password').value),'PBKDF2',false,['deriveBits']);
    const raw=await crypto.subtle.deriveBits({name:'PBKDF2',salt:b64bytes(meta.salt),iterations:meta.iterations,hash:'SHA-256'},material,256);
    const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
    await unlock(key);
    try { sessionStorage.setItem('jb-session',JSON.stringify({salt:meta.salt,key:bytesb64(raw)})); } catch {}
    $('login-status').textContent='';
  } catch(error) { $('login-status').textContent=error.name==='OperationError'?'비밀번호가 맞지 않거나 자료가 변경되었습니다. 다시 확인해 주세요.':error.message; }
  finally { $('login-button').disabled=false; }
});
$('reveal').addEventListener('click',()=>{const reveal=$('password').type==='password'; $('password').type=reveal?'text':'password'; $('reveal').textContent=reveal?'숨김':'표시';});
function options(id,values,label) { const select=$(id); select.innerHTML=`<option value="">${label}</option>`+values.map(([value,text])=>`<option value="${escape(value)}">${escape(text)}</option>`).join(''); }
function buildFilters() {
  options('year',[...new Set(state.cases.map(c=>c.year))].sort((a,b)=>b-a).map(y=>[y,`${y}년`]),'전체 연도');
  options('group',[...new Set(state.cases.map(c=>c.group))].sort((a,b)=>a.localeCompare(b,'ko')).map(g=>[g,g]),'전체 계열');
  const univs=new Map(); for(const c of state.cases) univs.set(c.univ,(univs.get(c.univ)||0)+1);
  options('univ',[...univs].sort((a,b)=>a[0].localeCompare(b[0],'ko')).map(([u,n])=>[u,`${u} (${n})`]),'전체 대학');
  options('form',[...new Set(state.cases.flatMap(c=>c.interview.form||[]))].sort().map(f=>[f,f]).concat([['unknown','미확인']]),'전체 형식');
}
function restoreHash() {
  const p=new URLSearchParams(location.hash.slice(1)); state.query=p.get('q')||''; $('query').value=state.query;
  for(const field of Object.keys(state.filters)) { const v=p.get(field)||''; $(field).value=v; state.filters[field]=$(field).value; }
  state.mode=p.get('view')==='questions'?'question':'case';
  state.favoritesOnly=p.get('saved')==='1';
}
function syncHash() {
  const p=new URLSearchParams(); if(state.query.trim())p.set('q',state.query.trim());
  for(const [k,v] of Object.entries(state.filters))if(v)p.set(k,v);
  if(state.mode==='question')p.set('view','questions');
  if(state.favoritesOnly)p.set('saved','1');
  if(state.selected)p.set('case',state.selected.id);
  history.replaceState(null,'',location.pathname+location.search+(p.size?'#'+p.toString():''));
}
function caseMatches(c) {
  const f=state.filters;
  return (!f.year||String(c.year)===f.year)&&(!f.group||c.group===f.group)&&(!f.univ||c.univ===f.univ)&&
    (!f.form||(f.form==='unknown'?!(c.interview.form||[]).length:(c.interview.form||[]).includes(f.form)))&&
    (!state.favoritesOnly||state.favorites.has(c.id))&&terms().every(t=>c._search.includes(t));
}
function applyFilters(resetLimit=true) {
  if(resetLimit)state.limit=60;
  const cases=state.cases.filter(caseMatches).sort((a,b)=>b.year-a.year||a.univ.localeCompare(b.univ,'ko')||a.dept.localeCompare(b.dept,'ko')||a.id.localeCompare(b.id));
  state.results=state.mode==='case'?cases.map(c=>({c})):cases.flatMap(c=>c.questions.map((q,i)=>({c,q,i})).filter(({q})=>terms().every(t=>norm([c.year,c.group,c.univ,univAlias(c),c.dept,c.admission,questionText(q)].join(' ')).includes(t))));
  $('case-mode').setAttribute('aria-pressed',state.mode==='case'); $('question-mode').setAttribute('aria-pressed',state.mode==='question');
  $('favorites').setAttribute('aria-pressed',state.favoritesOnly);
  $('result-count').textContent=`${state.mode==='case'?'검색 결과':'질문 결과'} ${state.results.length.toLocaleString()}${state.mode==='case'?'건':'개'}`;
  renderResults(); updateFavorite(); updateNavigation(); syncHash();
}
function renderResults() {
  const results=state.results.slice(0,state.limit);
  $('result-list').innerHTML=results.length?results.map(({c,q,i})=>{
    const active=c.id===state.selected?.id;
    const sample=snippet(c,q);
    return `<article class="result-card${active?' active':''}" data-case="${escape(c.id)}"><button class="card-open" data-open="${escape(c.id)}" ${q?`data-question="${i}"`:''} aria-label="${escape(c.univ+' '+c.dept+' '+c.admission+(q?' 질문 '+(i+1):' 사례 보기'))}" ${active?'aria-current="true"':''}><div class="card-kicker"><span>${c.year}</span><span>${escape(c.group)}</span></div><h3>${highlighted(c.univ)}</h3><div class="card-dept">${highlighted(c.dept)}</div><div class="card-admission">${highlighted(c.admission)}</div><div class="badges">${c.indexed?`<span class="badge ready">${(c.interview.form||[]).map(escape).join(' · ')||'형식 미확인'}</span><span class="badge">질문 ${c.questions.length}개</span>`:'<span class="badge">문항 정리 전</span>'}<span class="badge">PDF ${c.page_count}쪽</span>${q?`<span class="badge ready">Q${i+1}</span>`:''}</div>${sample?`<p class="snippet">${highlighted(sample)}</p>`:''}</button><button class="star" data-star="${escape(c.id)}" aria-label="${escape(c.univ+' '+c.dept)} 즐겨찾기 ${state.favorites.has(c.id)?'해제':'추가'}" aria-pressed="${state.favorites.has(c.id)}">${state.favorites.has(c.id)?'★':'☆'}</button></article>`;
  }).join(''):`<div class="list-empty"><h3>${state.favoritesOnly?'저장한 사례가 없습니다':'검색 결과가 없습니다'}</h3><p>${state.mode==='question'?'질문 보기는 문항이 정리된 사례만 검색합니다.':'검색어를 줄이거나 필터를 변경해 보세요.'}</p><button data-reset>검색 조건 초기화</button></div>`;
  $('list-more').innerHTML=state.results.length>state.limit?`<button id="more">더 보기 (${state.limit} / ${state.results.length})</button>`:'';
}
function clearFilters() {state.query='';$('query').value='';for(const field of Object.keys(state.filters)){$(field).value='';state.filters[field]='';}state.favoritesOnly=false;applyFilters();}
$('query').addEventListener('input',()=>{state.query=$('query').value;applyFilters();if(state.selected){renderInfo();$('detail-title').innerHTML=highlighted(state.selected.univ+' · '+state.selected.dept);}});
for(const field of Object.keys(state.filters))$(field).addEventListener('change',()=>{state.filters[field]=$(field).value;applyFilters();});
$('reset').addEventListener('click',clearFilters);
$('favorites').addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;applyFilters();});
$('case-mode').addEventListener('click',()=>{state.mode='case';applyFilters();});
$('question-mode').addEventListener('click',()=>{state.mode='question';applyFilters();});
$('result-list').addEventListener('click',e=>{const star=e.target.closest('[data-star]');if(star)return toggleFavorite(star.dataset.star);const open=e.target.closest('[data-open]');if(open)return selectCase(open.dataset.open,open.dataset.question);if(e.target.closest('[data-reset]'))clearFilters();});
$('list-more').addEventListener('click',()=>{state.limit+=60;renderResults();});
document.querySelectorAll('[data-query]').forEach(b=>b.addEventListener('click',()=>{state.query=b.dataset.query;$('query').value=state.query;applyFilters();}));
function resultIds() {return [...new Set(state.results.map(r=>r.c.id))];}
function updateNavigation() {
  const ids=resultIds(), i=ids.indexOf(state.selected?.id);
  $('detail-position').textContent=i<0?'현재 검색 결과 밖의 사례':`${i+1} / ${ids.length} 사례`;
  $('previous-case').disabled=i<=0; $('next-case').disabled=i<0||i>=ids.length-1;
}
function moveCase(delta) {const ids=resultIds(),i=ids.indexOf(state.selected?.id);if(i>=0&&ids[i+delta])selectCase(ids[i+delta]);}
function switchTab(tab,focus=false) {
  state.tab=tab; const pdf=tab==='pdf';
  $('pdf-panel').hidden=!pdf;$('info-panel').hidden=pdf;
  $('pdf-tab').setAttribute('aria-selected',pdf);$('info-tab').setAttribute('aria-selected',!pdf);
  $('pdf-tab').tabIndex=pdf?0:-1;$('info-tab').tabIndex=pdf?-1:0;
  if(focus)$(pdf?'pdf-tab':'info-tab').focus();
  if(pdf&&state.pdf)renderPage();
}
function answerMarkup(answer, id, label) {
  if(!String(answer || '').trim())return '';
  const open=state.openAnswers.has(id);
  const action=open?'답변 숨기기':'답변 보기';
  return `<button type="button" class="answer-toggle" data-answer-toggle="${id}" data-answer-label="${escape(label)}" aria-expanded="${open}" aria-controls="${id}" aria-label="${escape(label+' '+action)}">${action}</button><p class="answer" id="${id}"${open?'':' hidden'}><span class="answer-label">응답 사례</span>${highlighted(answer)}</p>`;
}
function updateAllAnswersButton() {
  const button=$('toggle-all-answers');if(!button)return;
  const toggles=[...$('info-panel').querySelectorAll('[data-answer-toggle]')];
  const allOpen=toggles.length>0&&toggles.every(b=>b.getAttribute('aria-expanded')==='true');
  button.textContent=allOpen?'답변 모두 숨기기':'답변 모두 보기';
}
function setAnswerVisibility(button, open) {
  const id=button.dataset.answerToggle;
  open?state.openAnswers.add(id):state.openAnswers.delete(id);
  $(id).hidden=!open;
  button.setAttribute('aria-expanded',open);
  button.textContent=open?'답변 숨기기':'답변 보기';
  button.setAttribute('aria-label',button.dataset.answerLabel+' '+button.textContent);
}
$('info-panel').addEventListener('click',event=>{
  const toggle=event.target.closest('[data-answer-toggle]');
  if(toggle)setAnswerVisibility(toggle,toggle.getAttribute('aria-expanded')!=='true');
  else if(event.target.closest('#toggle-all-answers')) {
    const toggles=[...$('info-panel').querySelectorAll('[data-answer-toggle]')];
    const open=!toggles.every(b=>b.getAttribute('aria-expanded')==='true');
    toggles.forEach(b=>setAnswerVisibility(b,open));
  } else return;
  updateAllAnswersButton();
});
function renderInfo() {
  const c=state.selected;if(!c)return;
  const rows=[['면접 형식',(c.interview.form||[]).join(' · ')],['면접 방식',(c.interview.mode||[]).join(' · ')],['반영 비율',c.interview.ratio],['면접 시간',c.interview.time],['진행 방법',c.interview.method],['원본 쪽수',c.pages.src?.length?c.pages.src.join('–')+'쪽 (계열 PDF)':''],['책 쪽수',c.pages.book?.length?c.pages.book.join('–')+'쪽':'']];
  const hasAnswers=c.questions.some(q=>String(q.a||'').trim()||(q.followups||[]).some(f=>String(f.a||'').trim()));
  const answerNote=hasAnswers?'답변은 ‘답변 보기’를 눌러 확인할 수 있습니다. 학생이 기억한 당시의 응답이며, 정답이나 모범답안이 아닙니다.':'이 사례에는 정리된 답변이 없습니다. 질문과 원본 PDF를 함께 확인해 주세요.';
  $('info-panel').innerHTML=`<h3>면접 정보</h3><dl class="info-grid">${rows.filter(([k,v])=>v).map(([k,v])=>`<dt>${k}</dt><dd>${highlighted(v)}</dd>`).join('')}</dl>${!c.indexed?'<div class="notice">아직 문항이 정리되지 않은 사례입니다. 질문과 면접 정보는 원본 PDF에서 확인해 주세요.</div>':`${c.intro_note?`<h3>면접 시작 전</h3><p class="etc">${highlighted(c.intro_note)}</p>`:''}<div class="questions-heading"><h3>면접 질문 <span class="muted">${c.questions.length}개</span></h3>${hasAnswers?'<button type="button" id="toggle-all-answers" class="answer-toggle">답변 모두 보기</button>':''}</div><p class="notice">${answerNote}</p>${c.questions.map((q,i)=>`<section class="question" id="question-${i}"><h4><span>Q${escape(q.no||i+1)}</span>${highlighted(q.q)}</h4>${answerMarkup(q.a,`answer-${i}`,`Q${q.no||i+1}`)}${(q.followups||[]).map((f,j)=>`<div class="followup"><p><span class="answer-label">꼬리질문</span>${highlighted(f.q)}</p>${answerMarkup(f.a,`answer-${i}-followup-${j}`,`Q${q.no||i+1} 꼬리질문 ${j+1}`)}</div>`).join('')}</section>`).join('')}${c.etc?`<h3>기타 면접정보</h3><p class="etc">${highlighted(c.etc)}</p>`:''}`}`;
  updateAllAnswersButton();
}
function resetPdf() {
  state.renderSerial++;state.renderTask?.cancel();state.renderTask=null;
  if(state.loadingTask)state.loadingTask.destroy().catch(()=>{});state.loadingTask=null;state.pdf=null;
  if(state.blob)URL.revokeObjectURL(state.blob);state.blob=null;
  const canvas=$('pdf-canvas');canvas.hidden=true;canvas.width=0;canvas.height=0;
  $('pdf-status').hidden=false;$('pdf-status').textContent='원본 PDF를 불러오는 중입니다…';
  for(const id of ['pdf-open','pdf-download','page-prev','page-next','page-input','zoom-in','zoom-out','fit'])$(id).disabled=true;
  $('page-total').textContent='/ —';
}
async function selectCase(id,questionIndex) {
  const c=state.cases.find(c=>c.id===id);if(!c)return;
  if(state.selected?.id!==id)state.openAnswers.clear();
  const gen=++state.generation;state.selected=c;state.page=1;state.zoom=1;resetPdf();
  $('detail-empty').hidden=true;$('detail').hidden=false;document.body.classList.add('detail-open');
  $('detail-kicker').textContent=`${c.year} · ${c.group}`;
  $('detail-title').innerHTML=highlighted(`${c.univ} · ${c.dept}`);
  $('detail-subtitle').innerHTML=highlighted(c.admission)+` <span class="muted">· 원본 ${c.page_count}쪽</span>`;
  renderInfo();switchTab('info');renderResults();updateFavorite();updateNavigation();syncHash();
  $('detail-pane').scrollTop=0;
  if(questionIndex!==undefined)$('question-'+questionIndex)?.scrollIntoView({block:'start'});
  try {
    const [raw,pdfjs]=await Promise.all([decryptFile(state.key,c.pdf,c.pdf),pdfModule??=import('./vendor/pdf.mjs')]);
    if(gen!==state.generation)return;
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw))).map(v=>v.toString(16).padStart(2,'0')).join('');
    if(gen!==state.generation)return;
    if(digest!==c.sha256)throw new Error('원본 PDF 무결성 검사에 실패했습니다. 자료를 다시 받아 주세요.');
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
    const loadingTask=pdfjs.getDocument({data:new Uint8Array(raw.slice(0)),isEvalSupported:false,enableXfa:false,useSystemFonts:true});
    state.loadingTask=loadingTask;
    const pdf=await loadingTask.promise;
    if(gen!==state.generation){loadingTask.destroy().catch(()=>{});return;}
    state.pdf=pdf;state.blob=URL.createObjectURL(new Blob([raw],{type:'application/pdf'}));
    $('page-total').textContent='/ '+pdf.numPages;$('page-input').max=pdf.numPages;
    for(const name of ['pdf-open','pdf-download','page-input','zoom-in','zoom-out','fit'])$(name).disabled=false;
    if(state.tab==='pdf')await renderPage();
  } catch(error) { if(gen!==state.generation)return; $('pdf-status').hidden=false;$('pdf-status').textContent=error.name==='OperationError'?'PDF 암호화 정보가 변경되었습니다. 잠근 뒤 다시 입장해 주세요.':`PDF를 열지 못했습니다. ${error.message}`; }
}
async function renderPage() {
  if(!state.pdf||state.tab!=='pdf')return;
  const serial=++state.renderSerial,gen=state.generation,pdf=state.pdf;
  state.renderTask?.cancel();
  try {
    const page=await pdf.getPage(state.page);
    if(serial!==state.renderSerial||gen!==state.generation)return;
    const natural=page.getViewport({scale:1});
    const available=Math.max(240,$('pdf-surface').clientWidth-(innerWidth<=760?16:44));
    const scale=available/natural.width*state.zoom,ratio=Math.min(devicePixelRatio||1,2);
    const viewport=page.getViewport({scale:scale*ratio});
    const canvas=$('pdf-canvas');canvas.width=Math.floor(viewport.width);canvas.height=Math.floor(viewport.height);canvas.style.width=Math.round(viewport.width/ratio)+'px';canvas.style.height=Math.round(viewport.height/ratio)+'px';canvas.hidden=false;
    $('pdf-status').hidden=true;
    state.renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport});await state.renderTask.promise;
    if(serial!==state.renderSerial)return;
    $('page-input').value=state.page;$('page-prev').disabled=state.page<=1;$('page-next').disabled=state.page>=pdf.numPages;
    $('zoom-value').textContent=Math.round(state.zoom*100)+'%';
    canvas.setAttribute('aria-label',`${state.selected.univ} ${state.selected.dept} 원본 ${state.page} / ${pdf.numPages}쪽`);
  } catch(error) {if(error.name!=='RenderingCancelledException'&&serial===state.renderSerial){$('pdf-status').hidden=false;$('pdf-status').textContent='쪽을 표시하지 못했습니다. 다른 쪽을 선택하거나 원본을 새 탭으로 열어 주세요.';}}
}
function setPage(value) {if(state.pdf){state.page=Math.min(state.pdf.numPages,Math.max(1,Number(value)||1));$('pdf-surface').scrollTop=0;renderPage();}}
$('page-input').addEventListener('change',()=>setPage($('page-input').value));$('page-prev').onclick=()=>setPage(state.page-1);$('page-next').onclick=()=>setPage(state.page+1);
$('zoom-in').onclick=()=>{state.zoom=Math.min(3,state.zoom+.25);renderPage();};$('zoom-out').onclick=()=>{state.zoom=Math.max(.5,state.zoom-.25);renderPage();};$('fit').onclick=()=>{state.zoom=1;renderPage();};
$('pdf-open').onclick=()=>{if(state.blob)window.open(state.blob+'#page='+state.page,'_blank','noopener,noreferrer');};
$('pdf-download').onclick=()=>{if(!state.blob)return;const a=document.createElement('a');a.href=state.blob;a.download=`${state.selected.year}_${state.selected.univ}_${state.selected.dept}_${state.selected.admission}.pdf`;a.click();};
$('pdf-tab').onclick=()=>switchTab('pdf');$('info-tab').onclick=()=>switchTab('info');
for(const id of ['info-tab','pdf-tab'])$(id).addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();switchTab(e.key==='Home'?'info':e.key==='End'?'pdf':state.tab==='pdf'?'info':'pdf',true);}});
$('previous-case').onclick=()=>moveCase(-1);$('next-case').onclick=()=>moveCase(1);$('detail-favorite').onclick=()=>state.selected&&toggleFavorite(state.selected.id);
$('back-list').onclick=()=>document.body.classList.remove('detail-open');
$('share').onclick=async()=>{syncHash();try{await navigator.clipboard.writeText(location.href);toast('현재 사례와 검색 조건의 링크를 복사했습니다.');}catch{toast('주소 표시줄의 링크를 복사해 주세요.');}};
$('help-open').onclick=()=>$('help').showModal();$('help-close').onclick=()=>$('help').close();
$('lock').onclick=()=>{try{sessionStorage.removeItem('jb-session');}catch{}state.generation++;resetPdf();state.key=null;state.cases=[];state.results=[];state.selected=null;location.reload();};
document.addEventListener('keydown',e=>{if($('app').hidden||$('help').open)return;const editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);if(e.key==='/'&&!editing){e.preventDefault();$('query').focus();}if(e.key==='Escape')document.body.classList.remove('detail-open');if(!editing&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.target.closest('[role=tablist]')){if(e.key==='ArrowLeft')moveCase(-1);if(e.key==='ArrowRight')moveCase(1);}});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>renderPage(),180);});
window.addEventListener('hashchange',()=>{if(!state.key)return;restoreHash();const wanted=new URLSearchParams(location.hash.slice(1)).get('case');applyFilters();if(wanted&&wanted!==state.selected?.id)selectCase(wanted);});
async function restoreSession() {
  try {const saved=JSON.parse(sessionStorage.getItem('jb-session')||'null');if(!saved)return;meta=await getMeta();if(saved.salt!==meta.salt){sessionStorage.removeItem('jb-session');return;}const key=await crypto.subtle.importKey('raw',b64bytes(saved.key),{name:'AES-GCM'},false,['decrypt']);await unlock(key);} catch {try{sessionStorage.removeItem('jb-session');}catch{} }
}
restoreSession();
