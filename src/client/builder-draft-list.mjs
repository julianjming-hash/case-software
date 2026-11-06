import {validDraftSummary,draftPublicationLabel,draftReviewLabel} from '../shared/draft-summary.mjs';
import {watchTheme} from './appearance-watch.mjs';
import { decorateTools } from './ui-icons.mjs';
import { accountRequest } from './auth-ui.mjs';
import { caseTile } from './case-tile.mjs';
import { guardDialog } from './dialog-behaviour.mjs';
import { isUuidV7 } from '../shared/ids.mjs';

const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 512 * 1024;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function validPage(value, workspaceId, offset) {
  if (!value || (value.summaryVersion!==undefined&&value.summaryVersion!==2) || value.workspaceId !== workspaceId || value.limit !== PAGE_SIZE || value.offset !== offset ||
      !Array.isArray(value.drafts) || value.drafts.length > PAGE_SIZE || typeof value.hasMore !== 'boolean' ||
      value.nextOffset !== offset + value.drafts.length) return false;
  const ids = new Set();
  for (const row of value.drafts) {
    if (!row || !isUuidV7(row.caseId) || ids.has(row.caseId) || typeof row.title !== 'string' || !row.title.length ||
        row.title.length > 200 || unsafeText.test(row.title) || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return false;
    if(value.summaryVersion===2&&!validDraftSummary(row))return false;
    ids.add(row.caseId);
  }
  return true;
}

/** Mounts a bounded content-free inventory. Draft bodies stay in the explicit per-case editor load. */
export function mountBuilderDraftList(host, { auth, workspaceId, onEdit = () => {}, current = () => true,
  request = accountRequest } = {}) {
  if (!host || !auth || typeof auth.sessionGeneration !== 'function' || !isUuidV7(workspaceId) || typeof request !== 'function')
    throw new TypeError('Saved drafts need an authenticated workspace and a host element.');
  const doc = host.ownerDocument ?? document, win = doc.defaultView ?? window;
  const accountGeneration = auth.sessionGeneration();
  let closed = false, loading = false, offset = 0, hasMore = false, operation = 0;
  let paintEpoch=0,paintings=[];let stopTheme=()=>{};if(doc.documentElement)stopTheme=watchTheme(()=>{void drawCovers();});
  let query='';const seen = new Set(); let modal=null,modalGuard=null;
  const root = doc.createElement('section'); root.className = 'builder-saved-drafts';
  root.setAttribute('aria-label', 'Saved private drafts');
  const heading = doc.createElement('h2'); heading.textContent = 'Drafts'; heading.className='sr-only';
  const note = doc.createElement('p'); note.textContent = 'Saved on Case. Unsaved writing stays in its open editor tab.'; note.className='small muted';
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const introduction = doc.createElement('div'); introduction.className='supporting-note'; introduction.append(note,status);
  const list = doc.createElement('ol');
  const controls = doc.createElement('div'); controls.className = 'builder-draft-list-controls';
  const refreshButton = doc.createElement('button'); refreshButton.type = 'button'; refreshButton.className = 'btn tertiary'; refreshButton.textContent = 'Refresh saved drafts';
  const moreButton = doc.createElement('button'); moreButton.type = 'button'; moreButton.className = 'btn quiet'; moreButton.textContent = 'Load more saved drafts'; moreButton.hidden = true;
  controls.append(refreshButton, moreButton); root.append(heading, introduction, list, controls); host.append(root);decorateTools(root);
  const alive = () => {
    try { return !closed && current() && auth.sessionGeneration() === accountGeneration; }
    catch { return false; }
  };
  const authTimer = win.setInterval?.(() => { if (!alive()) close(); }, 250);
  const pagehide = () => close(); win.addEventListener?.('pagehide', pagehide);

  function close() {
    if (closed) return; closed = true; operation++;
    win.removeEventListener?.('pagehide', pagehide);
    if (authTimer !== undefined) win.clearInterval?.(authTimer);
    paintEpoch++;stopTheme();paintings=[];modalGuard?.dispose();modal?.remove();modal=null;seen.clear(); offset = 0; hasMore = false; loading = false;
    list.replaceChildren(); root.replaceChildren(); root.remove();
  }
  function renderControls() { refreshButton.disabled = loading; moreButton.disabled = loading; moreButton.hidden = loading || !hasMore; }
  async function drawCovers(){
    const token=++paintEpoch, covers=[...paintings];
    try{
      const art=await import('./splash.mjs');
      for(const cover of covers){
        if(!alive()||token!==paintEpoch)return;
        if(!cover.solved){cover.art=cover.structure?art.artForStructure(cover.structure):null;cover.art??=art.BRAND_ART;cover.solved=true;}
        await art.paintCovers([cover],{cssSize:400});
        // Yield between bounded solves; a refresh, theme change or retirement fences this batch.
        await new Promise(resolve=>win.setTimeout?win.setTimeout(resolve,0):setTimeout(resolve,0));
      }
    }catch{/* Decorative fallback never delays editing. */}
  }
  function appendRow(row,rich=false) {
    if (seen.has(row.caseId)) return false;
    seen.add(row.caseId);
    const item = doc.createElement('li');
    const date=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(row.updatedAt));
    const context=doc.createElement('dl');context.className='draft-record';
    for(const [label,value] of [['Saved',date],['Revision',String(row.revision)]]){
      const fact=doc.createElement('div'),term=doc.createElement('dt'),definition=doc.createElement('dd');term.textContent=label;
      if(label==='Saved'){const saved=doc.createElement('time');saved.dateTime=row.updatedAt;saved.textContent=value;definition.append(saved);}else definition.textContent=value;
      fact.append(term,definition);context.append(fact);
    }
    let media=null;if(rich){media=doc.createElement('div');media.className='cover';media.setAttribute('aria-hidden','true');const canvas=doc.createElement('canvas');canvas.width=canvas.height=1;media.append(canvas);paintings.push({canvas,structure:row.artStructure,art:null,full:false,group:'neutral',contentSeed:row.caseId});}
    const metadata=rich?[...(row.durationMin===null?[]:[row.durationMin+' min']),...(row.audience?[row.audience]:[])]:['Private draft'];
    const states=rich?[{label:draftPublicationLabel(row)+(row.publicationVersion?' · v'+row.publicationVersion:''),tone:row.publicationState==='changed'?'priv':''},{label:draftReviewLabel(row),tone:row.reviewStatus==='pending'?'warn':row.reviewStatus?'priv':''}]:[];
    const card=caseTile({doc,title:row.title,metadata,states,media,context,className:'draft-tile',dialog:true,onOpen:()=>{
      if(!alive())return;modalGuard?.dispose();modal?.remove();modal=doc.createElement('dialog');modal.className='computer-dialog draft-details';modal.setAttribute('aria-label',row.title);
      const title=doc.createElement('h2');title.textContent=row.title;const facts=doc.createElement('p');facts.textContent='Saved '+date+' · Revision '+row.revision;
      const status=doc.createElement('p');status.textContent=rich?draftPublicationLabel(row)+(row.publicationVersion?' · v'+row.publicationVersion+' · '+new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(row.publicationAt)):'')+'. '+draftReviewLabel(row)+'. Readiness is checked before publication.':'Publication and check status are available in the editor.';status.className='small muted';
      const actions=doc.createElement('div');actions.className='dialog-actions';const cancel=doc.createElement('button'),edit=doc.createElement('button');cancel.type=edit.type='button';cancel.className='btn quiet';edit.className='btn primary';cancel.textContent='Cancel';edit.textContent='Edit case';actions.append(cancel,edit);modal.append(title,facts,status,actions);root.append(modal);
      modalGuard=guardDialog(modal,{opener:()=>card.open});cancel.onclick=()=>modalGuard.requestClose();edit.onclick=()=>{if(alive()){modal.close();onEdit(row.caseId);}};modal.showModal();edit.focus();
    }});item.dataset.title=row.title.toLowerCase();item.hidden=!item.dataset.title.includes(query);item.append(card.root);list.append(item);return true;
  }
  async function load({ reset = false } = {}) {
    if (!alive() || loading) return;
    if (reset) { operation++;paintEpoch++;paintings=[]; list.replaceChildren(); seen.clear(); offset = 0; hasMore = false; }
    const token = ++operation, start = offset; loading = true; status.textContent = 'Loading saved drafts…'; renderControls();
    try {
      const value = await request(auth, ['builder', 'workspaces', workspaceId, 'drafts'], {
        query: [['limit', String(PAGE_SIZE)], ['offset', String(start)],['v','2']], maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      if (!alive() || token !== operation) return;
      if (!validPage(value, workspaceId, start)) throw new Error('bad_page');
      const added = value.drafts.reduce((count, row) => count + Number(appendRow(row,value.summaryVersion===2)), 0);
      if(value.summaryVersion===2)void drawCovers();
      offset = value.nextOffset;
      hasMore = value.hasMore && offset < 10_000;
      status.textContent = seen.size === 0 ? 'No saved drafts yet. Save a new case to make it available here.' :
        added < value.drafts.length ? 'The saved draft list changed while paging. Refresh to see the current order.' : `${seen.size} saved draft${seen.size === 1 ? '' : 's'} loaded.`;
    } catch {
      if (!alive() || token !== operation) return;
      status.textContent = 'Saved drafts could not be loaded. Try again.';
      if (reset) { list.replaceChildren(); seen.clear(); offset = 0; hasMore = false; }
    } finally {
      if (token === operation) { loading = false; renderControls(); }
    }
  }
  refreshButton.addEventListener('click', () => void load({ reset: true }));
  moreButton.addEventListener('click', () => void load());
  void load({ reset: true });
  return { root,filter(value){query=value.trim().toLowerCase();for(const item of list.children)item.hidden=!item.dataset.title.includes(query);status.textContent=loading?'Loading saved drafts…':query?`${[...list.children].filter(n=>!n.hidden).length} of ${seen.size} loaded drafts match.`:`${seen.size} saved drafts loaded.`;}, refresh: () => load({ reset: true }), close, destroy: close };
}
