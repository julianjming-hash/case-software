import { menuIdentity as accountIdentity } from './navigation-access.mjs';
import { enhanceSelect } from './accessible-select.mjs';
// Standalone authenticated Builder URL. Private draft candidates remain in this page's memory.
import { mountAccount, accountRequest } from './auth-ui.mjs';
import { mountSiteHeader } from './site-header.mjs';
import { caseEditSourceViewUrl, caseEditUrl, caseEditViewUrl, caseNewUrl, caseEditWorkspaceUrl, caseWorkspaceUrl, parseCaseWorkspace, parseRoute } from '../shared/urls.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { mountBuilderForCurrentRoute } from './builder-lifecycle.mjs';

const BUILDER_PAGE_CSS_URL = '__BUILDER_PAGE_CSS_URL__';

const node = (doc, tag, text = null, className = '') => {
  const value = doc.createElement(tag);
  if (text !== null) value.textContent = text;
  if (className) value.className = className;
  return value;
};

/** Mount /cases/new and /cases/:id/edit[/workflows|/preview] as separate bounded pages. */
export function mountBuilderPage(main, { route = parseRoute(globalThis.location?.pathname ?? ''),
  authMount = mountAccount, headerMount = mountSiteHeader,
  loadBuilder = () => import('./builder-route.mjs'), request = accountRequest,
  createCase = async (...args) => (await import('./builder-api.mjs')).createBuilderCase(...args),
  createStarter = async () => (await import('./builder-templates.mjs')).createBuilderStoryStarter(),
  onBuilderMounted = () => {} } = {}) {
  if (!main || !['case-edit', 'case-new'].includes(route?.route) ||
      (route.route === 'case-edit' && (!isUuidV7(route.caseId) || ![undefined, 'workflows', 'preview', 'restore', 'overview'].includes(route.view) || (route.view === 'restore' && !route.sourceVersion) ||
        (route.sourceVersion && (!isUuidV7(route.sourceVersion.versionId) || !Number.isSafeInteger(route.sourceVersion.versionNo) || route.sourceVersion.versionNo < 1))))) return null;
  const doc = main.ownerDocument ?? globalThis.document, win = doc.defaultView ?? globalThis.window;
  if (!doc.getElementById('builder-page-styles')) {
    const link = doc.createElement('link'); link.id = 'builder-page-styles'; link.rel = 'stylesheet';
    link.href = new URL(BUILDER_PAGE_CSS_URL === '__BUILDER_PAGE_CSS_URL__' ? '/src/client/builder-page.css' : BUILDER_PAGE_CSS_URL, win.location.origin).href;
    doc.head.append(link);
  }
  let closed = false, generation = 0, builder = null, dirty = false, signedAuth = null, mePromise = null;
  const preferredWorkspace = parseCaseWorkspace(win.location.href).workspaceId;
  let activeWorkspaceId = preferredWorkspace;
  const readMe = auth => mePromise ??= request(auth, ['me'], { query: new URLSearchParams({ limit: '100', ...(preferredWorkspace ? { workspaceId: preferredWorkspace } : {}) }) });
  const menuIdentity = me => accountIdentity(me,()=>account.signOut?.click());
  let activeCaseId = route.caseId ?? null, activeSourceVersion = route.sourceVersion ?? null, requestedView = route.view ?? 'editor', candidate = null;
  main.replaceChildren(); main.classList.add('builder-page');
  const header = headerMount(doc.body, { context: 'Create', current: 'builder', getWorkspace: () => activeWorkspaceId, loadAccount: async () => {
    const auth = signedAuth, owner = generation; if (!auth) return null;
    const me = await readMe(auth); if (closed || owner !== generation || auth !== signedAuth) throw new Error('account_changed'); return menuIdentity(me);
  }, beforeNavigate: () => {
    if (!leaveAllowed()) return false;
    win.removeEventListener?.('beforeunload', beforeUnload); return true;
  }, signOutMessage: () => dirty ? 'Sign out and discard this unsaved in-memory draft? Saved revisions remain in your workspace.' : 'Sign out and clear private information on this device?' });
  header.setBreadcrumbs?.([{ label: 'Create', href: caseWorkspaceUrl(preferredWorkspace, 'drafts', win.location.origin) }, { label: route.route === 'case-new' ? 'New case' : 'Edit case' }]);
  // The Builder's tools join the site bar; the breadcrumb names the case being edited.
  const drafts = () => ({ label: 'Create', href: caseWorkspaceUrl(preferredWorkspace, 'drafts', win.location.origin) });
  const chrome = { bar: header.bar, setTitle: title => header.setBreadcrumbs?.([drafts(), { label: title }]) };
  const accountHost = node(doc, 'section', null, 'builder-page-account');
  accountHost.append(node(doc, 'h1', 'Create', 'sr-only'));
  const content = node(doc, 'section', null, 'builder-page-content');
  let workspacePicker = null;
  const clearPicker = () => { workspacePicker?.dispose(); workspacePicker = null; };
  const replaceContent = (...nodes) => { clearPicker(); content.replaceChildren(...nodes); };
  // The Builder's own region is named Case Builder; the page section names only the create route (landmark-unique).
  if (route.route === 'case-new') content.setAttribute('aria-label', 'Create a case draft');
  main.append(accountHost, content);
  const beforeUnload = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
  const live = () => !closed;
  const leaveAllowed = () => !dirty || Boolean(win.confirm?.('You have unsaved changes. Leave Create without saving them?'));
  const returnToCases = () => {
    if (!leaveAllowed()) return false;
    win.location.assign(caseWorkspaceUrl(activeWorkspaceId, 'drafts', win.location.origin)); return true;
  };
  const onPop = () => {
    const next = parseRoute(win.location.pathname);
    const sameSource = JSON.stringify(next?.sourceVersion ?? null) === JSON.stringify(activeSourceVersion);
    if (next?.route === 'case-edit' && next.caseId === activeCaseId && sameSource && next.view !== 'restore') {
      requestedView = next.view ?? 'editor';
      if (builder) void builder.setView(requestedView, { push: false });
      return;
    }
    if (!leaveAllowed()) {
      if (activeCaseId) win.history?.replaceState(null, '', activeSourceVersion
        ? caseEditSourceViewUrl(activeCaseId, activeSourceVersion, builder?.getView?.() ?? requestedView, win.location.origin)
        : caseEditViewUrl(activeCaseId, builder?.getView?.() ?? requestedView, win.location.origin));
      else win.history?.replaceState(null, '', caseNewUrl(win.location.origin));
      return;
    }
    win.location.reload();
  };
  win.addEventListener?.('popstate', onPop);

  function mountCandidate(auth, owner) {
    const startupCandidate = candidate;
    const targetCaseId = activeCaseId;
    replaceContent(node(doc, 'p', 'Opening the private draft…'));
    void mountBuilderForCurrentRoute({ expectedGeneration: owner, currentGeneration: () => generation,
      expectedHost: content, currentHost: () => content, load: loadBuilder,
      mount: module => {
      if (!live() || owner !== generation || targetCaseId !== activeCaseId) return null;
      const host = node(doc, 'div', null, 'builder-page-editor'); replaceContent(host);
      return module.mountBuilderCase(host, { auth, caseId: targetCaseId, sourceVersion: activeSourceVersion,
        initialCandidate: startupCandidate, initialView: requestedView, onBack: returnToCases, chrome,
        onCaseCreated(caseId) {
          if (!live() || owner !== generation || !isUuidV7(caseId)) return;
          activeCaseId = caseId; activeSourceVersion = null; candidate = null; requestedView = 'editor';
          win.history.replaceState(null, '', caseEditUrl(caseId, win.location.origin));
        },
        onDirty(value) {
          if (!live() || owner !== generation) return;
          dirty = Boolean(value);
          if (dirty) win.addEventListener?.('beforeunload', beforeUnload);
          else win.removeEventListener?.('beforeunload', beforeUnload);
        },
      });
    } }).then(mounted => {
      if (!mounted) return;
      builder = mounted;
      if (candidate === startupCandidate) candidate = null;
      onBuilderMounted({ caseId: activeCaseId, view: requestedView });
    }).catch(() => {
      if (live() && owner === generation) replaceContent(node(doc, 'p', 'Create could not be opened. The saved case remains unchanged.'));
    });
  }

  async function showNewCaseForm(auth, owner) {
    let memberships, nextAfter;
    try {
      const response = await readMe(auth);
      if (!live() || owner !== generation) return;
      nextAfter = isUuidV7(response?.nextAfter) ? response.nextAfter : null;
      memberships = (Array.isArray(response?.memberships) ? response.memberships : [])
        .filter(row => isUuidV7(row?.workspace_id) && ['admin', 'owner', 'author'].includes(row?.role));
    } catch {
      if (live() && owner === generation) {
        mePromise = null; const retry = node(doc, 'button', 'Retry workspace access', 'btn tertiary'); retry.type = 'button';
        retry.onclick = () => { if (live() && owner === generation) void showNewCaseForm(auth, owner); };
        replaceContent(node(doc, 'p', 'Workspace access could not be loaded.'), retry);
      } return;
    }
    if (!live() || owner !== generation) return;
    const form = node(doc, 'form', null, 'builder-new-case-form');
    const titleLabel = node(doc, 'label', 'Case title');
    const title = node(doc, 'input'); title.type = 'text'; title.maxLength = 200; title.required = true; title.autocomplete = 'off'; title.className = 'input'; titleLabel.append(title);
    const workspaceLabel = node(doc, 'label', 'Workspace');
    const workspace = node(doc, 'select'); workspace.required = true; workspace.className = 'input';
    for (const member of memberships) {
      const option = node(doc, 'option', member.name || 'Workspace'); option.value = member.workspace_id; workspace.append(option);
    }
    if (memberships.some(member => member.workspace_id === preferredWorkspace)) workspace.value = preferredWorkspace;
    workspaceLabel.append(workspace);
    const submit = node(doc, 'button', 'Create case draft', 'btn primary'); submit.type = 'submit';
    const status = node(doc, 'p'); status.setAttribute('role', 'status');
    form.append(titleLabel, workspaceLabel, submit, status);
    replaceContent(node(doc, 'h1', 'Create a case draft'), form);
    if (doc.defaultView?.HTMLSelectElement) workspacePicker = enhanceSelect(workspace, { label: 'Workspace' });
    if (!memberships.length) { submit.disabled = true; status.textContent = 'No authoring workspace is assigned to this account.'; }
    if (nextAfter && !preferredWorkspace) {
      const more = node(doc, 'button', 'More authoring workspaces', 'btn tertiary'); more.type = 'button'; form.append(more);
      more.onclick = async () => {
        more.disabled = true;
        try {
          const page = await request(auth, ['me'], { query: new URLSearchParams({ limit: '100', after: nextAfter }) });
          if (!live() || owner !== generation) return;
          if (!Array.isArray(page.memberships) || page.memberships.length > 100 || page.nextAfter !== null && (!isUuidV7(page.nextAfter) || page.nextAfter <= nextAfter)) throw new Error('bad_page');
          for (const member of page.memberships) if (isUuidV7(member?.workspace_id) && ['admin','owner','author'].includes(member.role) && !memberships.some(row => row.workspace_id === member.workspace_id)) {
            memberships.push(member); const option = node(doc, 'option', member.name || 'Workspace'); option.value = member.workspace_id; workspace.append(option);
          }
          nextAfter = page.nextAfter; more.hidden = !nextAfter; submit.disabled = !memberships.length;
          status.textContent = nextAfter ? 'More workspaces are available.' : memberships.length ? 'Authoring workspaces loaded.' : 'No authoring workspace is assigned to this account.';
        } catch { if (live() && owner === generation) status.textContent = 'The next workspaces could not be loaded. Try again.'; }
        finally { more.disabled = false; }
      };
    }
    let creating = false, creationUncertain = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!live() || owner !== generation || activeCaseId || creating || creationUncertain) return;
      const value = title.value.trim(), workspaceId = workspace.value;
      const membership = memberships.find(row => row.workspace_id === workspaceId);
      if (!value || !membership) { status.textContent = 'Choose a workspace and enter a title.'; return; }
      submit.disabled = true; creating = true; status.textContent = 'Creating a private case…';
      try {
        const caseId = await createCase((parts, options) => request(auth, parts, options), workspaceId, value);
        if (!live() || owner !== generation) return;
        candidate = await createStarter();
        if (!live() || owner !== generation) return;
        candidate.document.title = value;
        activeCaseId = caseId; activeWorkspaceId = workspaceId; activeSourceVersion = null; requestedView = 'editor';
        win.history.replaceState(null, '', caseEditWorkspaceUrl(caseId, workspaceId, win.location.origin));
        mountCandidate(auth, owner);
      } catch (error) {
        if (live() && owner === generation) {
          const definite = [400, 401, 403, 404, 409].includes(error?.status);
          creationUncertain = !definite;
          submit.disabled = creationUncertain;
          status.textContent = creationUncertain
            ? 'The create request may have succeeded, so it will not be repeated. Check your saved drafts for the new case.'
            : 'The case could not be created. Your form is still here; correct the issue and try again.';
          if (creationUncertain) {
            const drafts = node(doc, 'button', 'Return to saved drafts', 'btn tertiary'); drafts.type = 'button';
            drafts.addEventListener('click', () => { if (live() && owner === generation) win.location.assign(caseWorkspaceUrl(activeWorkspaceId, 'drafts', win.location.origin)); });
            form.append(drafts);
          } else submit.disabled = false;
        }
      } finally {
        creating = false;
      }
    });
  }

  const account = authMount(accountHost, { idleText: 'Sign in to edit a private draft in Create.', onSignedIn(auth) {
    const owner = ++generation; signedAuth = auth; mePromise = null; header.setAccount?.(null);
    void readMe(auth).then(me => { if (live() && owner === generation) header.setAccount?.(menuIdentity(me)); }).catch(() => { if (owner === generation) mePromise = null; });
    builder?.close?.(); builder = null; dirty = false;
    win.removeEventListener?.('beforeunload', beforeUnload);
    if (route.route === 'case-new' && !activeCaseId) void showNewCaseForm(auth, owner);
    else mountCandidate(auth, owner);
  }, onSignedOut() {
    generation++; signedAuth = null; mePromise = null; header.setAccount?.(null); builder?.close?.(); builder = null; dirty = false; candidate = null;
    win.removeEventListener?.('beforeunload', beforeUnload); replaceContent();
  } });
  return { close() {
    if (closed) return; closed = true; signedAuth = null; mePromise = null; generation++; builder?.close?.(); builder = null; candidate = null;
    win.removeEventListener?.('popstate', onPop); win.removeEventListener?.('beforeunload', beforeUnload);
    clearPicker(); header?.remove?.(); main.replaceChildren();
  }, getBuilder: () => builder, account };
}
