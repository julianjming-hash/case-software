import { builderPublicationIssues } from '../shared/builder-publication.mjs';
// Served Builder adapter. This is the only place the authoring studio meets authenticated API and C42.
import { accountRequest, node } from './auth-ui.mjs';
import { createBuilderSaveState } from './builder-save-state.mjs';
import { createInspector } from './run-preview-window.mjs';
export { createInspector };
import { mountKeyedNativeFields } from './builder-editor.mjs';
import { mountBuilderPanels } from './builder-workspace.mjs';
import { mountNativeFormatEditor } from './format-editor.mjs';
import { renderFormattedText } from './formatted-text.mjs';
import { validateFormattedText } from '../shared/builder-format.mjs';
import { builderSourceSha256 } from '../shared/builder-metadata.mjs';
import { validateBuilderDocument as validateDocument } from '../shared/builder-document.mjs';
import { isUuidV7, uuidv7 } from '../shared/ids.mjs';
import { caseEditSourceViewUrl, caseEditViewUrl } from '../shared/urls.mjs';
import { builderCaseContext, createBuilderApi, createBuilderCase } from './builder-api.mjs';
import { builderTemplates, createBuilderStarter, createBuilderStoryStarter } from './builder-templates.mjs';
import { createCheckpointPanel } from './builder-checkpoints.mjs';
import { withImageNames } from './builder-image-issues.mjs';

const clone = value => structuredClone(value);
const DEFAULT_METADATA = () => ({ metadata_version: 1, preparation_requirements: '' });
const MAX_DRAFT_BYTES = 2 * 1_048_576;
const BUILDER_STUDIO_CSS_URL = '__BUILDER_STUDIO_CSS_URL__';

function ensureBuilderStyles() {
  if (document.getElementById('builder-studio-styles')) return;
  const link = document.createElement('link'); link.id = 'builder-studio-styles'; link.rel = 'stylesheet';
  link.href = new URL(BUILDER_STUDIO_CSS_URL === '__BUILDER_STUDIO_CSS_URL__' ? '/src/client/builder-studio.css' : BUILDER_STUDIO_CSS_URL, location.origin).href;
  document.head.append(link);
}

function canonicalPair(value, validate) {
  if (value?.draft === null && value?.revision === 0) return null;
  const draft = value?.draft;
  if (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || !draft.document || typeof draft.document !== 'object')
    throw new Error('This draft could not be loaded safely.');
  const authoringMetadata = draft.authoringMetadata ?? DEFAULT_METADATA();
  const checked = validate(draft.document, authoringMetadata, { mode: 'preserve' });
  if (!checked.ok) throw new Error('This saved draft contains unsupported data and cannot be edited without losing it.');
  return { revision: draft.revision, document: draft.document, authoringMetadata, intentDigest: draft.intentDigest };
}

/** Mount an authenticated case draft; `initialCandidate` is used only for a newly-created empty case. */
export async function mountBuilderCase(host, { auth, caseId, workspaceId = null, sourceVersion = null, initialCandidate = null, initialView = 'editor', chrome = null, onBack = () => {}, onDirty = () => {}, onCaseCreated = () => {} } = {}) {
  if (!isUuidV7(caseId) || (workspaceId !== null && !isUuidV7(workspaceId))) throw new TypeError('Builder needs a case UUIDv7.');
  ensureBuilderStyles();
  let closed = false, studio = null, nested = null, workflows = null, generation = 0, currentView = 'editor', applyView = null, slideModule = null;
  const accountGeneration = auth.sessionGeneration();
  const current = () => !closed && auth.sessionGeneration() === accountGeneration;
  const root = node('section', null, 'builder-route');
  const status = node('p', 'Loading saved case draft…', 'builder-route-status'); status.setAttribute('role', 'status');
  root.append(status); host.replaceChildren(root);

  async function loadSourceDraft() {
    const response = await accountRequest(auth, ['builder', 'cases', caseId, 'draft'], { maxResponseBytes: MAX_DRAFT_BYTES });
    const { workspaceId: authorizedWorkspaceId, role } = builderCaseContext(response, caseId, workspaceId);
    // P-15 (CASE-338): an owner or administrator publishes; an editor only where the workspace lets editors publish.
    const publishes = role === 'admin' || response?.case?.publishes === true;
    // Card 51: slide drafts load only when the server grants slide_composition; until then schema 3 stays refused.
    // The canvas chunk follows when the editor view is shown (setView).
    const slides = Array.isArray(response?.case?.capabilities) && response.case.capabilities.includes('slide_composition') ? await import('./builder-slide-check.mjs') : null;
    const validate = (document, metadata, options) => validateDocument(document, metadata, slides ? { ...options, validateSlides: slides.validateSlideParts } : options);
    const existing = canonicalPair(response, validate);
    if (existing) return { ...existing, workspaceId: authorizedWorkspaceId, role, publishes, slides, validate };
    if (initialCandidate) return { revision: 0, document: clone(initialCandidate.document), authoringMetadata: clone(initialCandidate.authoringMetadata), workspaceId: authorizedWorkspaceId, role, publishes, slides, validate };
    // A published case without a Builder draft is copied exactly into a new private draft. The source
    // version is recorded as lineage; the published pack remains authoritative until the first save.
    let source = sourceVersion ?? response?.case?.sourceVersion ?? null;
    if (!source) {
      // Entitled GET context distinguishes a never-published private case from a published case
      // whose source must be copied. Never probe another version implicitly for a new case.
      if (!Object.hasOwn(response?.case ?? {}, 'sourceVersion') || typeof response.case.title !== 'string')
        throw new Error('The case authoring context is unavailable. Reload and try again.');
      const fresh = slides ? createBuilderStoryStarter() : createBuilderStarter('single_choice');
      fresh.document.title = response.case.title;
      return { revision: 0, document: fresh.document, authoringMetadata: fresh.authoringMetadata,
        workspaceId: authorizedWorkspaceId, role, publishes, freshStarter: true, slides, validate };
    }
    if (!isUuidV7(source.versionId) || !Number.isSafeInteger(source.versionNo)) throw new Error('The source version is unavailable.');
    const selected = await accountRequest(auth, ['cases', caseId, 'versions', String(source.versionNo)]);
    if (selected?.case?.case_id !== caseId || selected.case.workspace_id !== authorizedWorkspaceId ||
        selected.case.version_id !== source.versionId || selected.case.version_no !== source.versionNo)
      throw new Error('The selected published source does not belong to this case.');
    const pack = await accountRequest(auth, ['workspaces', authorizedWorkspaceId, 'versions', source.versionId, 'pack'], { maxResponseBytes: MAX_DRAFT_BYTES });
    if (pack?.workspaceId !== authorizedWorkspaceId || pack?.versionId !== source.versionId || !pack.document)
      throw new Error('The published source version could not be loaded.');
    const authoringMetadata = { ...DEFAULT_METADATA(), lineage: { source_case_id: caseId, source_version_id: source.versionId } };
    const checked = validate(pack.document, authoringMetadata, { mode: 'preserve' });
    if (!checked.ok) throw new Error('The published source includes content Create does not yet preserve. It was not copied.');
    return { revision: 0, document: pack.document, authoringMetadata, workspaceId: authorizedWorkspaceId, role, publishes, sourceVersion: source, slides, validate };
  }

  async function mountCurrent(candidate = null) {
    const owner = ++generation;
    status.textContent = 'Loading saved case draft…';
    try {
      const initial = await loadSourceDraft();
      if (!current() || owner !== generation) return;
      const authorizedWorkspaceId = initial.workspaceId;
      // PUBLISH-01 (card 62): this workspace's images and their statuses, read only when publishing refused an image.
      // CASE-342: this case's images (a Can edit grant sees only these; a member sees the workspace's).
      const listWorkspaceImages = async () => (await accountRequest(auth, ['builder', 'cases', caseId, 'assets'], { maxResponseBytes: 2_097_152 }))?.assets;
      const api = createBuilderApi({ request: (parts, options) => accountRequest(auth, parts, options), caseId, workspaceId: authorizedWorkspaceId,
        initialWhenMissing: { document: initial.document, authoringMetadata: initial.authoringMetadata } });
      root.replaceChildren();
      const header = node('header', null, 'builder-route-header');
      const back = node('button', 'Back to Create', 'btn tertiary'); back.type = 'button';
      back.addEventListener('click', () => onBack());
      const publishLabel = initial.publishes ? 'Publish' : 'Send for review';
      const workflowsButton = node('button', publishLabel, 'builder-btn builder-primary'); workflowsButton.type = 'button';
      workflowsButton.setAttribute('aria-label', publishLabel);
      const labelPublish = () => workflowsButton.replaceChildren(node('span', '↑'), node('span', publishLabel, 'builder-private')); labelPublish();
      const workflowHost = node('section', null, 'builder-workflows-view'); workflowHost.hidden = true;
      const mountHost = node('div', null, 'builder-editor-view');
      // The workspace shell (app-bar tools, menus, panel heads, history) loads with the studio.
      const [{ mountBuilderStudio }, shell] = await Promise.all([import('./builder-studio.mjs'), import('./builder-shell.mjs')]);
      if (!current() || owner !== generation) return;
      shell.ensureShellStyles(document);
      root.append(header, mountHost, workflowHost);
      let creating = false, creationUncertain = false, viewGeneration = 0, slideCanvas = null;
      // Run preview (CASE-226): one window, or the same surface inline when pop-ups are blocked; it never navigates the Builder.
      const inspect = createInspector({ ownerWindow: host.ownerDocument?.defaultView ?? window, sourceDocument: document, auth, onNotice: message => { status.textContent = message; studio?.notice?.(message); },
        isCurrent: () => current() && owner === generation, onFailed: message => { status.textContent = message; studio?.notice?.(message); } });
      const createNewCase = async ({ candidate: nextCandidate, provenance }) => {
          const next = clone(nextCandidate);
          const fallbackTitle = provenance?.kind === 'template' ? `${provenance.templateName || 'Starter'} case` : 'Untitled case';
          const title = String(next.document.title || fallbackTitle).trim().slice(0, 200) || 'Untitled case';
          next.document.title = title;
          if (creating || creationUncertain) throw new Error('Case creation is unresolved. Return to your cases to inspect the result before creating another.');
          creating = true;
          let newCaseId;
          try { newCaseId = await createBuilderCase((parts, options) => accountRequest(auth, parts, options), authorizedWorkspaceId, title); }
          catch (error) { creationUncertain = ![400,401,403,404,409].includes(error?.status); throw error; }
          finally { creating = false; }
          if (!current() || owner !== generation) return;
          // The selected candidate is carried only in this in-memory call. It is marked dirty so the
          // first explicit Save writes it through the revision-0 operation window.
          const newHost = node('div');
          root.replaceChildren(header, newHost);
          workflows?.close(); workflows = null; studio?.destroy(); studio = null;
          onDirty(false, { status: 'saved', revision: 0 });
          onCaseCreated(newCaseId);
          nested = await mountBuilderCase(newHost, { auth, caseId: newCaseId, workspaceId: authorizedWorkspaceId,
            initialCandidate: next, chrome, onBack, onDirty, onCaseCreated });
          if (!current() || owner !== generation) nested?.close?.();
          return { created: !closed && owner === generation };
        };
      studio = mountBuilderStudio(mountHost, {
        initial: candidate ? { revision: 0, document: clone(candidate.document), authoringMetadata: clone(candidate.authoringMetadata) } : initial,
        publicationIssues: builderPublicationIssues,
        // PUBLISH-01 (card 62): a refused image is named by its slide, text alternative and status in this workspace.
        publicationCheck: async revision => withImageNames(await accountRequest(auth, ['builder', 'cases', caseId, 'readiness'], { method: 'POST', body: { revision } }),
          studio?.getSnapshot?.().document, () => listWorkspaceImages()),
        templates: builderTemplates(), createId: uuidv7,
        validateDocument: initial.validate, slides: initial.slides, inspect, shell, chrome, primaryAction: workflowsButton, menuItems: [back],
        validateFormattedText: value => validateFormattedText(value),
        mountFields: (container, options) => mountKeyedNativeFields(container, options),
        mountPanels: mountBuilderPanels,
        mountFormatEditor: (container, options) => mountNativeFormatEditor(container, options),
        renderFormattedText: (document, value) => renderFormattedText(document, value, { validateFormattedText }),
        createSaveState: options => createBuilderSaveState({ ...options,
          services: { ...api.saveServices, validate: ({ document, authoringMetadata }) => initial.validate(document, authoringMetadata, { mode: 'preserve' }).errors } }),
        saveServices: api.saveServices, checkpointServices: api.checkpointServices, checkpointPanel: createCheckpointPanel,
        createScratch: () => initial.slides ? createBuilderStoryStarter() : createBuilderStarter('single_choice'),
        hashSourceText: builderSourceSha256,
        onDirty,
        isCurrent: current,
        onCreate: createNewCase,
        archiveDraft: ['owner', 'admin'].includes(initial.role) ? confirmTitle => accountRequest(auth, ['builder', 'cases', caseId, 'archive'], { method: 'POST', body: { confirmTitle } }) : null,
        onArchived: onBack,
        // Closing the inline Run preview opened by /edit/preview returns the address to the editor.
        preview: { onLeave: () => { if (currentView === 'preview') void setView('editor', { push: true, activate: false }); } },
        // Opening or leaving the Overview inside the studio moves the address with it (CASE-321).
        onView: view => { if ((view === 'overview') !== (currentView === 'overview') && currentView !== 'workflows') void setView(view, { push: true }); },
      });
      if (candidate || initial.freshStarter) studio.saveState.setDraft(initial.document, initial.authoringMetadata);
      const setView = async (view, { push = true, activate = true } = {}) => {
        if (!['editor', 'workflows', 'preview', 'overview'].includes(view) || !current() || owner !== generation) return false;
        const navigation = ++viewGeneration;
        currentView = view; workflowsButton.hidden = view === 'workflows';
        if (push) {
          const win = host.ownerDocument?.defaultView ?? globalThis.window;
          const source = sourceVersion ?? initial.sourceVersion;
          win.history.pushState(null, '', source
            ? caseEditSourceViewUrl(caseId, source, view, win.location.origin)
            : caseEditViewUrl(caseId, view, win.location.origin));
        }
        // The Overview (CASE-321) is the editor showing the case's overview in place of the slide, at its own address.
        if (view === 'editor' || view === 'overview') {
          workflows?.close?.(); workflows = null; workflowHost.replaceChildren(); workflowHost.hidden = true;
          mountHost.hidden = false; studio.closePreview?.(); studio.openView?.(view === 'overview' ? 'overview' : 'editor');
          if (initial.slides && !slideCanvas) {
            slideCanvas = import('./builder-slides.mjs');
            try {
              const module = await slideCanvas; module.ensureSlideStyles(document);
              if (current() && owner === generation) {
                // Card 59 M2: images of this workspace, read and uploaded with the account's token in the header.
                slideModule = module;
                module.setMediaServices({ workspaceId: authorizedWorkspaceId, caseId, origin: location.origin, canApprove: initial.role === 'admin', token: async () => auth.accessToken() ?? await auth.restore(), refresh: () => auth.refresh() });
                studio.setSlides(module);
              }
            }
            catch { slideCanvas = null; if (current() && owner === generation) { status.textContent = 'Slide editing could not be loaded. The saved draft is unchanged.'; studio.slidesUnavailable?.(); } }
          }
          return true;
        }
        if (view === 'preview') {
          workflows?.close?.(); workflows = null; workflowHost.replaceChildren(); workflowHost.hidden = true;
          mountHost.hidden = false;
          // Slide editing loads only in the editor view; until then Readiness counts without waiting for a fit pass.
          if (!slideCanvas) studio.slidesUnavailable?.();
          if (activate) studio.openPreview?.({ navigate: false });
          return true;
        }
        studio.closePreview?.(); mountHost.hidden = true; workflowHost.hidden = false;
        if (workflows) return true;
        workflowsButton.disabled = true; workflowsButton.textContent = 'Loading publishing…';
        workflowHost.replaceChildren();
        const returnButton = node('button', 'Return to case editing', 'btn tertiary'); returnButton.type = 'button';
        returnButton.addEventListener('click', () => { void setView('editor'); workflowsButton.focus?.(); });
        const loading = node('p', 'Loading publishing tools…'); loading.setAttribute('role', 'status');
        workflowHost.append(returnButton, loading);
        try {
          const module = await import('./builder-workflows.mjs');
          if (!current() || owner !== generation || navigation !== viewGeneration || currentView !== 'workflows') return false;
          workflowHost.replaceChildren(returnButton);
          // P-15: pass the effective publishing capability without changing the person's actual role.
          workflows = module.mountBuilderWorkflows(workflowHost, { caseId, canReview: initial.publishes, nameImages: (readiness, draft) => withImageNames(readiness, draft, listWorkspaceImages, { withSlide: true }), validateDocument: initial.validate, slides: Boolean(initial.slides), request: (parts, options) => accountRequest(auth, parts, options),
            studio, readLatest: api.readLatest, initialDigest: initial.intentDigest ?? null, current,
            createCopy: async next => { const result = await createNewCase({ candidate: { document: next.document, authoringMetadata: next.authoring_metadata }, provenance: { kind: 'copy' } }); return { ok: result?.created === true }; },
          });
          return true;
        } catch {
          if (current() && owner === generation && navigation === viewGeneration) {
            workflowHost.hidden = true; mountHost.hidden = false; currentView = 'editor'; workflowsButton.hidden = false;
            status.textContent = 'Publish and transfer tools could not be loaded. Your editor remains open.';
          }
          return false;
        } finally {
          if (current() && owner === generation) { workflowsButton.disabled = false; labelPublish(); }
        }
      };
      applyView = setView;
      workflowsButton.addEventListener('click', async () => { if (await setView('workflows') && initial.publishes) await workflows?.publish?.(); });
      await setView(initialView === 'restore' ? 'editor' : initialView, { push: false, activate: true });
      if (initialView === 'restore' && sourceVersion && current() && owner === generation) {
        try {
        const selected = await accountRequest(auth, ['cases', caseId, 'versions', String(sourceVersion.versionNo)]);
        if (selected?.case?.case_id !== caseId || selected.case.workspace_id !== authorizedWorkspaceId || selected.case.version_id !== sourceVersion.versionId)
          throw Error('The selected update does not belong to this case.');
        const pack = await accountRequest(auth, ['workspaces', authorizedWorkspaceId, 'versions', sourceVersion.versionId, 'pack'], { maxResponseBytes: MAX_DRAFT_BYTES });
        const metadata = { ...DEFAULT_METADATA(), lineage: { source_case_id: caseId, source_version_id: sourceVersion.versionId } };
        if (pack?.workspaceId !== authorizedWorkspaceId || pack?.versionId !== sourceVersion.versionId || !initial.validate(pack.document, metadata, { mode: 'preserve' }).ok)
          throw Error('This published update cannot be restored safely.');
        if (!current() || owner !== generation) return;
        const expected = studio.getSnapshot().localGeneration, dialog = node('dialog', null, 'computer-dialog');
        dialog.setAttribute('aria-label', 'Restore published update');
        dialog.append(node('h2', 'Restore as private draft?'), node('p', 'This replaces the current draft with the published content. Private source notes are not part of a published snapshot. Publishing and existing rooms stay unchanged.'));
        const cancel = node('button', 'Keep current draft', 'btn quiet'), confirm = node('button', 'Restore draft', 'btn primary'); cancel.type = confirm.type = 'button';
        const finish = () => { dialog.close(); dialog.remove(); void setView('editor', { push: true, activate: false }); };
        cancel.addEventListener('click', finish);
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
        confirm.addEventListener('click', () => {
          const state = studio.getSnapshot();
          if (!current() || state.localGeneration !== expected || !['saved', 'dirty'].includes(state.status)) {
            dialog.append(node('p', 'The draft changed or its save needs attention. Keep the current draft and review Versions again.')); confirm.disabled = true; return;
          }
          studio.historyBoundary('A published update replaced this private draft.');
          studio.saveState.setDraft(pack.document, metadata); finish();
          studio.notice('Published content restored as a private draft.');
        });
        dialog.append(cancel, confirm); root.append(dialog); dialog.showModal(); cancel.focus();
        } catch (error) {
          if (current() && owner === generation) studio.notice(error?.message || 'This update could not be restored. The current draft remains open.');
        }
      }
    } catch (error) {
      if (!closed && owner === generation) {
        root.replaceChildren(status, node('p', error?.message || 'The case draft could not be loaded.'));
        const back = node('button', 'Back to Create', 'btn'); back.type = 'button'; back.addEventListener('click', onBack); root.append(back);
      }
    }
  }

  await mountCurrent(initialCandidate);
  return { getView: () => currentView, setView: (view, options) => applyView?.(view, options) ?? false,
    close() { closed = true; generation++; applyView = null; workflows?.close(); studio?.destroy(); nested?.close?.(); root.remove(); slideModule?.setMediaServices(null); } };
}
