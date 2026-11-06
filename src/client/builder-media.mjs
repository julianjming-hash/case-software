import { enhanceSelect, disposeSelects } from './accessible-select.mjs';
// Builder images, GIFs and videos (card 59 M2, CASE-268; CASE-342 after image approval was removed), loaded only when a slide
// holds one or the author adds one. Everything a file goes through happens here, in the author's browser, before any byte leaves
// it. A still is decoded, cropped, covered where the author blacks out labels, and re-encoded as two JPEG renditions with no
// metadata. An animated GIF or a video keeps its frames: its comments, location, device and time data are removed in place
// (media-gif.mjs, media-mp4.mjs, loaded only then), and a JPEG poster is drawn from it. An upload is one dialog: the file, what
// it shows, an optional credit, and the warning with its confirmation tick. The image is usable at once: nothing waits for an
// approval. Images live in the case's place (/builder/cases/<id>/…), where a Can edit grant uploads and sees only that case's
// images. The dialog is text and DOM only (no HTML strings); styles are set through the CSSOM.
import { MEDIA_LIMITS, MEDIA_RENDITIONS, ECG_PHONE, EVIDENCE_KINDS, MEDIA_TYPES, cleanJpeg, inputKind, assetDetails } from '../shared/media.mjs';
import { builderAssetsPath, builderAssetRenditionPath, builderCaseAssetsPath, builderCaseAssetRenditionPath, builderCaseMediaUploadPath, builderAssetWithdrawPath, builderMediaUploadPath, mediaObjectUrl, adminApiUrl } from '../shared/urls.mjs';

const KIND_NAMES = { photo: 'Photograph', ecg: 'ECG', imaging: 'Imaging (X-ray, CT, ultrasound)', diagram: 'Diagram', other: 'Other image' };
const ERRORS = { rendition_in_use: 'Part of this upload is already used by another image. Upload the original file again.', media_limit: 'Too many uploads this hour (60 an hour). Try again later.', asset_closed: 'This file was taken down and cannot be used again.',
  image_too_large: 'The image is still too large after resizing.', unsupported_type: 'Choose an image, a GIF, or an MP4 or MOV video.', case_archived: 'This case is archived, so it cannot take new images.' };
// A refused field is named with its limit (invalid_details:<field>), never "check the details".
const FIELD_ERRORS = { alt: `Say what the image shows (up to ${MEDIA_LIMITS.altText} characters).`, credit: `The credit can be at most ${MEDIA_LIMITS.attribution} characters.`,
  attested: 'Tick the box to confirm the image is de-identified and that you may use it.', evidenceKind: 'Choose what kind of image this is.',
  creator: `The creator can be at most ${MEDIA_LIMITS.creator} characters.`, attribution: `The credit can be at most ${MEDIA_LIMITS.attribution} characters.`,
  rightsNote: `The licence note can be at most ${MEDIA_LIMITS.rightsNote} characters.`, sourceUrl: 'The source web address must start with https://.', source: 'Choose a source.' };
const megabytes = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
// Why a GIF or video could not be used, in the author's terms (media-gif.mjs, media-mp4.mjs reasons).
const MOVING_ERRORS = { hevc: 'This video is HEVC ("High Efficiency"), which many screens cannot play. Export it as H.264 ("Most Compatible") and try again.',
  unsupported_codec: 'This video format cannot play on every screen. Export it as an H.264 MP4 and try again.', too_long: 'Videos can be at most 2 minutes.',
  too_large: 'Videos can be at most 25 MB; GIFs at most 12 MB.', fragmented: 'This video is a streaming fragment. Export it as a single MP4 and try again.',
  external_data: 'This video refers to data outside the file. Export it as a single MP4 and try again.', decode_bomb: 'This GIF has too many frames or pixels to show safely.',
  bad_size: 'This file is too large in pixels (or too small) to show.' };
const KIND_LABELS = { 'image/gif': 'Animated GIF', 'video/mp4': 'Video' };
let formId = 0;

/** Fetch with the signed-in account's token in the header (never in the URL); one refresh on 401. */
async function authorized(services, path, init = {}, timeoutMs = 20_000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await services.token();
    if (!token) throw new Error('sign_in_required');
    const response = await fetch(new URL(path, services.origin).href, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs), headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (response.status === 401 && attempt === 0 && await services.refresh()) continue;
    return response;
  }
  throw new Error('sign_in_required');
}
async function failure(response) {
  let body = null; try { body = await response.json(); } catch { /* no body */ }
  const code = typeof body?.error === 'string' ? body.error : '';
  let named = ERRORS[code] ?? MOVING_ERRORS[code.replace('invalid_image:', '')] ?? (code.startsWith('invalid_image') ? 'That file could not be stored cleanly.' : null);
  if (code.startsWith('invalid_details:')) named = FIELD_ERRORS[code.slice('invalid_details:'.length)] ?? 'One of the image’s details was refused.';
  // The full workspace says how much is used and how much is allowed (CASE-342).
  if (code === 'storage_full' && Number.isFinite(body?.usedBytes) && Number.isFinite(body?.quotaBytes))
    named = `This workspace’s image storage is full: ${megabytes(body.usedBytes)} used of ${megabytes(body.quotaBytes)} allowed. Ask an administrator to free space or raise the limit.`;
  // The code travels with the words, so a caller can tell one refusal from another.
  return Object.assign(new Error(named ?? `The image could not be saved (${response.status}).`), { code });
}

// The case's place when the Builder hands one over (every Builder view does); the workspace's otherwise.
const upload = (services, rendition) => services.caseId ? builderCaseMediaUploadPath(services.caseId, rendition) : builderMediaUploadPath(services.workspaceId, rendition);
const assets = services => services.caseId ? builderCaseAssetsPath(services.caseId) : builderAssetsPath(services.workspaceId);
const rendition = (services, assetId, name) => services.caseId ? builderCaseAssetRenditionPath(services.caseId, assetId, name) : builderAssetRenditionPath(services.workspaceId, assetId, name);

/** The case's images (a member sees the workspace's), newest first, as the Worker lists them. */
export async function listImages(services) {
  const response = await authorized(services, assets(services));
  if (!response.ok) throw await failure(response);
  const body = await response.json();
  return Array.isArray(body?.assets) ? body.assets : [];
}

/** One rendition as a browser-local handle, or { state } when it is withdrawn or gone. */
export async function fetchImage(services, assetId, variant = 'display') {
  const response = await authorized(services, rendition(services, assetId, variant));
  if (response.status === 410) return { state: 'withdrawn' };
  const type = response.headers.get('content-type');
  if (!response.ok || !Object.hasOwn(MEDIA_TYPES, type)) return { state: 'missing' };
  const blob = new Blob([await response.arrayBuffer()], { type });
  return { url: mediaObjectUrl(blob), type };
}

/** Card 59 M4: email the signed-in admin a step-up code (the admin surface's own step-up). */
export async function requestStepUp(services) {
  const response = await authorized(services, adminApiUrl(services.origin, 'stepup_start'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (response.status !== 202) throw new Error(response.status === 429 ? 'Too many codes requested. Wait a few minutes.' : 'The code could not be sent.');
}
/** Take an image down with the emailed code: the step-up elevation travels only in a header (J8). */
export async function withdrawImage(services, assetId, { reason, code }) {
  const verified = await authorized(services, adminApiUrl(services.origin, 'stepup_verify'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!verified.ok) throw new Error('That code did not work. Request a new one.');
  const { elevation } = await verified.json();
  const response = await authorized(services, builderAssetWithdrawPath(services.workspaceId, assetId), { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-elevation': elevation }, body: JSON.stringify({ reason }) });
  if (!response.ok) throw await failure(response);
}

/** Decode a chosen still, upright, refusing sizes outside the allowlist (J3: 12 MB). */
export async function openFile(file) {
  if (!(file instanceof Blob)) throw new Error('Choose an image file.');
  if (file.size > MEDIA_LIMITS.inputBytes) throw new Error('Images can be at most 12 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This browser cannot open that file. Save it as JPEG or PNG and try again.'); }
  if (bitmap.width * bitmap.height > MEDIA_LIMITS.inputPixels) { bitmap.close(); throw new Error('Images can be at most 40 megapixels.'); }
  return bitmap;
}

/** A plain poster when the browser cannot draw a frame of the video (it is still stored and plays where it can). */
function plainPoster(width, height, label) {
  const scale = Math.min(1, 1280 / Math.max(width, height)), w = Math.max(MEDIA_LIMITS.minEdge, Math.round(width * scale)), h = Math.max(MEDIA_LIMITS.minEdge, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
  g.fillStyle = '#1f2328'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff'; g.font = `${Math.max(12, Math.round(h / 12))}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, w / 2, h / 2);
  return createImageBitmap(canvas);
}

/** A frame of a video (or null when this browser cannot decode it), drawn from the cleaned bytes. */
function videoFrame(doc, bytes, seconds) {
  return new Promise(resolve => {
    const url = mediaObjectUrl(new Blob([bytes], { type: 'video/mp4' })), video = doc.createElement('video');
    let done = false;
    const end = value => { if (done) return; done = true; clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => end(null), 8000);
    video.muted = true; video.preload = 'auto'; video.playsInline = true;
    video.addEventListener('error', () => end(null));
    video.addEventListener('loadeddata', () => { video.currentTime = Math.min(0.5, seconds / 2); });
    video.addEventListener('seeked', () => { createImageBitmap(video).then(end, () => end(null)); });
    video.src = url;
  });
}

/**
 * Open any file the author chose (J1 as re-ruled): `{ kind: 'still', bitmap }`, or for an animated GIF or a video
 * `{ kind, type, bytes, bitmap, width, height, durationMs }` where `bytes` is already cleaned and `bitmap` is the frame
 * the poster is drawn from. A one-frame GIF is a still.
 */
export async function openMedia(doc, file) {
  if (!(file instanceof Blob)) throw new Error('Choose a file.');
  const kind = inputKind(file);
  if (!kind) throw new Error(ERRORS.unsupported_type);
  if (kind === 'still') return { kind, bitmap: await openFile(file) };
  if (kind === 'gif') {
    if (file.size > MEDIA_LIMITS.inputBytes) throw new Error('GIFs can be at most 12 MB.');
    const { cleanGif, inspectGif } = await import('../shared/media-gif.mjs');
    const bytes = cleanGif(new Uint8Array(await file.arrayBuffer()));
    const shape = bytes && inspectGif(bytes);
    if (!shape?.ok) throw new Error(MOVING_ERRORS[shape?.reason] ?? 'This GIF could not be read. Save it again and try once more.');
    if (shape.frames === 1) return { kind: 'still', bitmap: await openFile(file) };
    return { kind, type: 'image/gif', bytes, bitmap: await openFile(new Blob([bytes], { type: 'image/gif' })), width: shape.width, height: shape.height, durationMs: null };
  }
  if (file.size > MEDIA_LIMITS.videoBytes) throw new Error('Videos can be at most 25 MB.');
  const { cleanMp4 } = await import('../shared/media-mp4.mjs');
  const cleaned = cleanMp4(new Uint8Array(await file.arrayBuffer()));
  if (!cleaned.bytes) throw new Error(MOVING_ERRORS[cleaned.reason] ?? 'This video could not be read. Export it as an H.264 MP4 and try again.');
  const minutes = `${Math.floor(cleaned.seconds / 60)}:${String(Math.round(cleaned.seconds % 60)).padStart(2, '0')}`;
  const bitmap = await videoFrame(doc, cleaned.bytes, cleaned.seconds) ?? await plainPoster(cleaned.width, cleaned.height, `Video · ${minutes}`);
  return { kind, type: 'video/mp4', bytes: cleaned.bytes, bitmap, width: cleaned.width, height: cleaned.height, durationMs: Math.round(cleaned.seconds * 1000) };
}

/**
 * One stored rendition: the crop, scaled to the rendition's longest edge, the covered areas painted solid black into the
 * pixels, re-encoded as JPEG and stripped to clean JFIF. Quality, then size, step down until it fits.
 */
export async function renderRendition(bitmap, crop, covers, { maxEdge, maxBytes }) {
  let scale = Math.min(1, maxEdge / Math.max(crop.w, crop.h));
  for (let attempt = 0; attempt < 8; attempt++, scale *= 0.8) {
    const w = Math.max(MEDIA_LIMITS.minEdge, Math.round(crop.w * scale)), h = Math.max(MEDIA_LIMITS.minEdge, Math.round(crop.h * scale));
    const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    g.fillStyle = '#000000';
    for (const c of covers) g.fillRect((c.x - crop.x) * w / crop.w, (c.y - crop.y) * h / crop.h, c.w * w / crop.w, c.h * h / crop.h);
    for (const quality of [0.86, 0.78, 0.7, 0.62]) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const bytes = cleanJpeg(new Uint8Array(await blob.arrayBuffer()));
      if (bytes && bytes.length <= maxBytes) return { bytes, width: w, height: h };
    }
  }
  throw new Error(ERRORS.image_too_large);
}

/** Store one rendition and return its stored sha256. A video may take up to two minutes on a slow connection. */
async function put(services, name, type, bytes) {
  const response = await authorized(services, upload(services, name), { method: 'PUT', headers: { 'content-type': type }, body: bytes },
    type === 'image/jpeg' ? 20_000 : 150_000);
  if (!response.ok) throw await failure(response);
  return (await response.json()).sha256;
}

/** Store a GIF's or video's cleaned file once (display and phone) and its JPEG poster, then register it. */
export async function uploadMoving(services, opened, { details }) {
  const display = await put(services, 'display', opened.type, opened.bytes);
  const posterMade = await renderRendition(opened.bitmap, { x: 0, y: 0, w: opened.bitmap.width, h: opened.bitmap.height }, [], MEDIA_RENDITIONS.poster);
  const poster = await put(services, 'poster', 'image/jpeg', posterMade.bytes);
  const response = await authorized(services, assets(services), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display: { sha256: display, type: opened.type }, phone: { sha256: display }, poster: { sha256: poster }, details }) });
  if (!response.ok) throw await failure(response);
  return (await response.json()).asset;
}

/** Store both renditions, then register the image with its details. Returns the asset row. */
export async function uploadImage(services, bitmap, { crop, covers, details }) {
  const ecg = details.evidenceKind === 'ecg', stored = {};
  for (const [name, limits] of [['display', MEDIA_RENDITIONS.display], ['phone', ecg ? ECG_PHONE : MEDIA_RENDITIONS.phone]]) {
    const made = await renderRendition(bitmap, crop, covers, limits);
    const response = await authorized(services, upload(services, name), { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: made.bytes });
    if (!response.ok) throw await failure(response);
    stored[name] = { sha256: (await response.json()).sha256 };
  }
  const response = await authorized(services, assets(services), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display: stored.display, phone: stored.phone, details }) });
  if (!response.ok) throw await failure(response);
  return (await response.json()).asset;
}

// ── dialog ───────────────────────────────────────────────────────────────────────────
const el = (doc, tag, text = null, style = null) => { const node = doc.createElement(tag); if (text !== null) node.textContent = text; if (style) Object.assign(node.style, style); return node; };
const button = (doc, text, onClick, primary = false) => { const node = el(doc, 'button', text); node.type = 'button'; node.className = primary ? 'builder-btn builder-confirm' : 'builder-btn'; node.addEventListener('click', onClick); return node; };
const field = (doc, label, control) => { const wrap = el(doc, 'label', null, { display: 'grid', gap: '4px' }); wrap.append(el(doc, 'span', label), control); return wrap; };

/**
 * The Image or ECG dialog: choose one of the workspace's images, or upload a new one through crop, cover and rights.
 * Resolves `{ asset }` for the chosen image, or null when closed. The caller adds or replaces the block.
 */
export function chooseImage(doc, services, { title = 'Image, GIF, video or ECG', file = null } = {}) {
  return new Promise(resolve => {
    const dialog = el(doc, 'dialog', null, { width: 'min(760px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: '20px', border: '1px solid var(--field-line)', borderRadius: '8px', background: 'var(--surface)', color: 'var(--ink)' });
    dialog.className = 'builder-media-dialog'; dialog.setAttribute('aria-label', title);
    const status = el(doc, 'p', '', { minHeight: '1.4em', margin: '0' }); status.setAttribute('role', 'status');
    const urls = [], cleanup = []; let closed = false;
    const finish = value => { if (closed) return; closed = true; disposeSelects(dialog); for (const fn of cleanup) fn(); for (const url of urls) URL.revokeObjectURL(url); dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    const head = el(doc, 'div', null, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' });
    head.append(el(doc, 'h2', title, { margin: '0', fontSize: '1.2rem' }), button(doc, 'Close', () => finish(null)));
    const tabs = el(doc, 'div', null, { display: 'flex', gap: '8px', margin: '12px 0' }); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Choose or upload');
    const body = el(doc, 'div');
    const show = name => { disposeSelects(body); for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.tab === name)); body.replaceChildren(name === 'library' ? library() : upload()); };
    for (const [name, label] of [['library', 'Your images'], ['upload', 'Upload new']]) { const tab = button(doc, label, () => show(name)); tab.dataset.tab = name; tabs.append(tab); }
    dialog.append(head, tabs, body, status);

    function library() {
      const grid = el(doc, 'ul', null, { listStyle: 'none', margin: '0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px' });
      grid.setAttribute('aria-label', services.caseId ? 'Images of this case' : 'Workspace images');
      status.textContent = 'Loading images…';
      listImages(services).then(rows => {
        const usable = rows.filter(row => row.status === 'quarantined' || row.status === 'approved');
        status.textContent = usable.length ? '' : 'No images yet. Upload one.';
        for (const row of usable) {
          const item = el(doc, 'li'), choose = button(doc, '', () => finish({ asset: row }));
          Object.assign(choose.style, { display: 'grid', gap: '6px', width: '100%', textAlign: 'start', padding: '8px', height: 'auto' });
          const thumb = el(doc, 'img', null, { width: '100%', aspectRatio: '4 / 3', objectFit: 'contain', background: 'var(--figure-card)', color: 'var(--figure-ink)' });
          thumb.alt = row.alt_text;
          fetchImage(services, row.asset_id, row.media_type === 'video/mp4' ? 'poster' : 'phone').then(found => { if (found.url) { urls.push(found.url); thumb.src = found.url; } }, () => {});
          const form = KIND_LABELS[row.media_type] ? `${KIND_LABELS[row.media_type]} · ` : '';
          choose.append(thumb, el(doc, 'span', row.alt_text), el(doc, 'small', `${form}${KIND_NAMES[row.evidence_kind] ?? 'Image'}`));
          choose.setAttribute('aria-label', `Use ${row.alt_text}`);
          item.append(choose); grid.append(item);
        }
      }, error => { status.textContent = error.message; });
      return grid;
    }

    function upload() {
      const wrap = el(doc, 'div', null, { display: 'grid', gap: '12px' });
      const input = el(doc, 'input'); input.type = 'file'; input.accept = 'image/*,video/mp4,video/quicktime,.heic,.heif,.mov,.mp4,.m4v';
      const editor = el(doc, 'div', null, { display: 'grid', gap: '8px' });
      const form = el(doc, 'div', null, { display: 'grid', gap: '10px' });
      wrap.append(field(doc, 'File: any image (up to 12 MB), an animated GIF (12 MB), or an MP4 or MOV video (25 MB, 2 minutes)', input), editor, form);
      let bitmap = null, crop = null, covers = [], mode = 'cover', opened = null, generation = 0;
      cleanup.push(() => bitmap?.close());
      const load = async file => {
        const ticket = ++generation;
        status.textContent = 'Opening…'; editor.replaceChildren(); disposeSelects(form); form.replaceChildren();
        try { const next = await openMedia(doc, file);
          if (closed || ticket !== generation || !wrap.isConnected) { next.bitmap.close(); return; }
          bitmap?.close(); opened = next; bitmap = opened.bitmap; }
        catch (error) { status.textContent = error.message; opened = null; return; }
        crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }; covers = [];
        if (opened.kind === 'still') {
          status.textContent = 'Ready to add. Cropping and covering are optional; describe it and confirm below.';
          const [canvas, tools] = canvasEditor(), options = el(doc, 'details');
          options.append(el(doc, 'summary', 'Crop and cover'), tools);
          options.addEventListener('toggle', () => { canvas.style.cursor = options.open ? 'crosshair' : 'auto'; });
          editor.append(canvas, options);
        } else {
          status.textContent = 'Location, device and time data have been removed. Frames cannot be cropped or covered: check every frame for names, dates, record numbers or faces.';
          editor.append(movingPreview());
        }
        form.append(...detailsForm());
        for (const select of form.querySelectorAll('select')) enhanceSelect(select, { label: 'Kind' });
      };
      input.addEventListener('change', () => load(input.files?.[0]));
      if (file) queueMicrotask(() => load(file));

      // An animated GIF or a video plays here as it will be stored (already cleaned).
      function movingPreview() {
        const url = mediaObjectUrl(new Blob([opened.bytes], { type: opened.type })); urls.push(url);
        const preview = el(doc, opened.type === 'video/mp4' ? 'video' : 'img', null, { maxWidth: '100%', maxHeight: '420px', background: 'var(--figure-card)' });
        if (opened.type === 'video/mp4') { preview.controls = true; preview.playsInline = true; preview.preload = 'metadata'; preview.setAttribute('aria-label', 'Video being prepared'); }
        else preview.alt = 'Animated GIF being prepared';
        preview.src = url;
        return preview;
      }

      function canvasEditor() {
        const scale = Math.min(1, 680 / bitmap.width, 420 / bitmap.height), canvas = el(doc, 'canvas', null, { maxWidth: '100%', cursor: 'auto', touchAction: 'none', border: '1px solid var(--field-line)' });
        canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Image being prepared; use Crop and Cover by dragging');
        const g = canvas.getContext('2d');
        const draw = (draft = null) => {
          g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          g.fillStyle = '#000000'; for (const c of covers) g.fillRect(c.x * scale, c.y * scale, c.w * scale, c.h * scale);
          g.strokeStyle = '#d4371c'; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale); g.setLineDash([]);
          if (draft) { g.strokeStyle = '#1b5e9b'; g.strokeRect(draft.x * scale, draft.y * scale, draft.w * scale, draft.h * scale); }
        };
        const point = event => { const box = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(bitmap.width, (event.clientX - box.left) / box.width * bitmap.width)), y: Math.max(0, Math.min(bitmap.height, (event.clientY - box.top) / box.height * bitmap.height)) }; };
        const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
        let start = null;
        canvas.addEventListener('pointerdown', event => {
          if (!tools.closest('details')?.open) return; start = point(event); canvas.setPointerCapture(event.pointerId); });
        canvas.addEventListener('pointermove', event => { if (start) draw(rect(start, point(event))); });
        canvas.addEventListener('pointerup', event => {
          if (!start) return; const area = rect(start, point(event)); start = null;
          if (area.w >= 4 && area.h >= 4) { if (mode === 'crop') crop = area; else covers.push(area); }
          draw(); undo.disabled = !covers.length;
        });
        const tools = el(doc, 'div', null, { display: 'flex', flexWrap: 'wrap', gap: '8px' }); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Prepare the image');
        const modeButton = (name, label) => { const node = button(doc, label, () => { mode = name; for (const item of [coverMode, cropMode]) item.setAttribute('aria-pressed', String(item === node)); }); node.setAttribute('aria-pressed', String(mode === name)); return node; };
        const coverMode = modeButton('cover', 'Cover with black'), cropMode = modeButton('crop', 'Crop');
        const undo = button(doc, 'Undo last cover', () => { covers.pop(); draw(); undo.disabled = !covers.length; }); undo.disabled = true;
        // Keyboard and switch users: cover the top strip, where printed ECG headers carry patient details.
        const strip = button(doc, 'Cover top strip (10%)', () => { covers.push({ x: 0, y: 0, w: bitmap.width, h: Math.round(bitmap.height * 0.1) }); draw(); undo.disabled = false; });
        const reset = button(doc, 'Reset', () => { crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }; covers = []; draw(); undo.disabled = true; });
        tools.append(coverMode, cropMode, undo, strip, reset);
        draw();
        return [canvas, tools];
      }

      function detailsForm() {
        // One form (CASE-342): what it shows, the kind, an optional credit, and the warning with its confirmation tick.
        const replacing = title === 'Replace image';
        const alt = el(doc, 'textarea'); alt.rows = 2; alt.maxLength = MEDIA_LIMITS.altText; alt.required = true;
        const kind = el(doc, 'select'); for (const value of EVIDENCE_KINDS) { const option = el(doc, 'option', KIND_NAMES[value]); option.value = value; kind.append(option); }
        const credit = el(doc, 'input'); credit.type = 'text'; credit.maxLength = MEDIA_LIMITS.attribution;
        const attest = el(doc, 'input'); attest.type = 'checkbox';
        const warning = el(doc, 'p', 'Before you add it: check that this image shows nothing that identifies a patient (no name, date of birth, record or accession number, dates, face, tattoo, jewellery or wristband), and that you are allowed to use it. Case cannot check this for you.', { margin: '0', color: 'var(--ink-muted)' });
        warning.id = `media-warning-${++formId}`;
        const attestLabel = el(doc, 'label', null, { display: 'flex', gap: '8px', alignItems: 'flex-start' });
        attest.setAttribute('aria-describedby', warning.id);
        attestLabel.append(attest, el(doc, 'span', 'I confirm this image is de-identified and I may use it.'));
        const read = () => ({ alt: alt.value.trim(), evidenceKind: kind.value, credit: credit.value, attested: attest.checked });
        const save = button(doc, 'Add image', async () => {
          // The same check the Worker makes, so the field named here is the field that is wrong.
          const details = read(), checked = assetDetails(details, { relaxed: true });
          if (!checked.ok) { status.textContent = FIELD_ERRORS[checked.field] ?? 'Check the details.'; (checked.field === 'alt' ? alt : checked.field === 'credit' ? credit : kind).focus(); return; }
          if (!details.attested) { status.textContent = FIELD_ERRORS.attested; attest.focus(); return; }
          save.disabled = true; status.textContent = opened.kind === 'video' ? 'Uploading the video…' : 'Preparing and uploading…';
          try {
            const asset = opened.kind === 'still' ? await uploadImage(services, bitmap, { crop, covers, details }) : await uploadMoving(services, opened, { details });
            finish({ asset, alt: details.alt });
          } catch (error) { status.textContent = error.message; save.disabled = false; }
        }, true);
        return [...(replacing ? [el(doc, 'p', 'Replacing an image: describe the new one. The old description is not kept.', { margin: '0' })] : []),
          field(doc, 'What it shows (its text alternative; describe it, do not give the answer away)', alt), field(doc, 'Kind', kind), field(doc, 'Credit (optional)', credit),
          warning, attestLabel, save];
      }
      return wrap;
    }

    doc.body.append(dialog); dialog.showModal(); show(file ? 'upload' : 'library');
  });
}
