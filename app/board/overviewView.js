// Overview preserves source workflows; coordination is explicit and optional.
function getOverviewState() {
  if (!window.__overviewState) window.__overviewState = {
    isOpen: false, initialized: false, query: '', projects: [], tab: 'projects',
    expanded: new Set(), completed: new Set(), requestId: 0, lastRefreshAt: 0,
    refreshPromise: null, signature: '', editing: null,
  };
  return window.__overviewState;
}
function isOverviewOpen() { return getOverviewState().isOpen; }
function buildOverviewProject(boardRoot, snapshot, brief = {}) {
  const boardDisplayName = snapshot.boardName || getBoardLabelFromPath(boardRoot);
  const lists = snapshot.lists.filter((list) => list.listName !== 'XXX-Archive').map((list) => {
    const isCompletedList = isBoardListCompletedByWorkflow(list.listName, (snapshot.boardSettings && snapshot.boardSettings.workflow) || {});
    return {
      listName: list.listName, listDisplayName: getBoardListDisplayName(list.listName), isCompletedList,
      cards: list.cards.flatMap((record) => {
        const card = getBoardSnapshotCardData(record);
        if (!card) return [];
        const frontmatter = card.frontmatter || {};
        return [{ boardRoot, boardDisplayName, listName: list.listName, isCompletedList,
          listDisplayName: getBoardListDisplayName(list.listName),
          cardPath: getBoardSnapshotCardPath(list.listPath, record),
          title: String(frontmatter.title || '').trim() || 'Untitled', body: String(card.body || ''),
          start: String(frontmatter.start || ''), due: String(frontmatter.due || ''), revision: card.revision,
          hasWorkStatus: SignboardProjectCoordination.WORK_STATUSES.includes(frontmatter.sb_work_status),
          coordination: SignboardProjectCoordination.normalizeCardCoordination(frontmatter),
          updatedAt: card.timestamps && card.timestamps.updatedAt,
        }];
      }),
    };
  });
  const cards = lists.flatMap((list) => list.cards);
  const actionable = cards.filter((card) => !card.isCompletedList);
  const active = actionable.filter((card) => card.coordination.workStatus === 'working' ||
    (!card.hasWorkStatus && /^(doing|in progress)$/i.test(card.listDisplayName)));
  return { boardRoot, boardDisplayName, lists, brief,
    active, blocked: actionable.filter((card) => card.coordination.workStatus === 'blocked'),
    requests: actionable.filter((card) => card.coordination.attention && card.coordination.attention !== 'none'),
    error: snapshot.ok === false || Boolean(snapshot.errors && snapshot.errors.length),
    cardCount: cards.length,
  };
}
function overviewCardMatchesQuery(card, query) {
  return overviewTextMatchesQuery([card.boardDisplayName, card.listDisplayName, card.title, card.body,
    ...Object.values(card.coordination || {})].join('\n'), query);
}
function overviewTextMatchesQuery(text, query) {
  const haystack = String(text || '').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}
function filterOverviewProjects(projects, query) {
  const searching = Boolean(String(query || '').trim());
  return projects.map((project) => {
    const summaryMatch = searching && overviewTextMatchesQuery([project.boardDisplayName, project.brief.goal, project.brief.nextStep].join('\n'), query);
    const lists = project.lists.map((list) => ({ ...list, cards: list.cards.filter((card) => summaryMatch || overviewCardMatchesQuery(card, query)) }))
      .filter((list) => !searching || list.cards.length > 0);
    return { ...project, lists, summaryMatch, visibleCount: lists.reduce((count, list) => count + list.cards.length, 0) };
  }).filter((project) => !searching || project.summaryMatch || project.visibleCount > 0 || project.error || project.briefError);
}
async function readOverviewProject(boardRoot) {
  try {
    const [snapshot, briefResult] = await Promise.all([
      readBoardSnapshotForRender(boardRoot, { includeBoardSettings: true, includeTimestamps: true, includeTaskItems: false }),
      window.board.readProjectBrief(boardRoot).then((brief) => ({ brief }), (error) => ({ brief: {}, error: error.message })),
    ]);
    await Promise.all(snapshot.lists.map(async (list) => {
      list.cards = await Promise.all(list.cards.map(async (record) => {
        if (getBoardSnapshotCardData(record)) return record;
        const cardPath = getBoardSnapshotCardPath(list.listPath, record);
        try { return { cardPath, ...await window.board.readCard(cardPath) }; }
        catch (error) { snapshot.errors.push({ cardPath }); return null; }
      }));
      list.cards = list.cards.filter(Boolean);
    }));
    return { ...buildOverviewProject(boardRoot, snapshot, briefResult.brief), briefError: briefResult.error };
  } catch (error) {
    return { boardRoot, boardDisplayName: getBoardLabelFromPath(boardRoot), lists: [], brief: {}, active: [], blocked: [], requests: [], cardCount: 0, error: true };
  }
}
function createOverviewText(tag, className, text) {
  const element = document.createElement(tag); element.className = className; element.textContent = text; if (className === 'overview-goal' || className === 'overview-next-step') element.title = text; return element;
}
function overviewButton(text, className, action) {
  const button = createOverviewText('button', className, text); button.type = 'button';
  button.addEventListener('click', action); return button;
}
function openOverviewSourceCard(card) {
  openPlannerCard(card).catch((error) => {
    console.error('Failed to open Overview card.', error);
    if (!isModalOpen('modalEditCard')) announceSignboardStatus('This card could not be opened. Check folder access and try again.');
  });
}
function renderOverviewCard(card) {
  const row = document.createElement('div'); row.className = 'overview-card-row';
  const button = overviewButton('', 'overview-card', (event) => { event.preventDefault(); event.stopPropagation(); openOverviewSourceCard(card); });
  button.dataset.path = card.cardPath; button.dataset.focusKey = `card:${card.cardPath}`;
  button.setAttribute('aria-label', `${card.title}, ${card.boardDisplayName}, ${card.listDisplayName}`);
  button.appendChild(createOverviewText('span', 'overview-card-title', card.title));
  const preview = card.coordination.summary || card.body.replace(/\s+/g, ' ').trim();
  if (preview) button.appendChild(createOverviewText('span', 'overview-card-preview', preview.slice(0, 180)));
  const signals = [card.hasWorkStatus && card.coordination.workStatus, card.coordination.attention !== 'none' && card.coordination.attention,
    card.start && `Start ${card.start}`, card.due && `Due ${card.due}`].filter(Boolean).join(' · ');
  if (signals) button.appendChild(createOverviewText('span', 'overview-card-dates', signals));
  row.appendChild(button);
  const edit = overviewButton('Coordinate', 'overview-coordinate', () => openOverviewCoordinationEditor({ card }));
  edit.dataset.focusKey = `coordinate:${card.cardPath}`; edit.setAttribute('aria-label', `Coordinate ${card.title}`); row.appendChild(edit); return row;
}
function renderOverviewLists(project, section) {
  const state = getOverviewState();
  const searching = Boolean(state.query.trim());
  const completedCount = project.lists.filter((list) => list.isCompletedList).reduce((count, list) => count + list.cards.length, 0);
  if (completedCount && !searching) {
    const show = state.completed.has(project.boardRoot);
    const toggle = overviewButton(`${show ? 'Hide' : 'Show'} completed · ${completedCount}`, 'overview-completed-toggle', () => {
      if (show) state.completed.delete(project.boardRoot); else state.completed.add(project.boardRoot); renderOverviewProjects();
    });
    toggle.dataset.focusKey = `completed:${project.boardRoot}`; toggle.setAttribute('aria-expanded', String(show)); section.appendChild(toggle);
  }
  const container = document.createElement('div'); container.className = 'overview-lists';
  for (const list of project.lists) {
    if (list.isCompletedList && !searching && !state.completed.has(project.boardRoot)) continue;
    const listSection = document.createElement('section'); listSection.className = 'overview-list';
    listSection.appendChild(createOverviewText('h4', 'overview-list-title', `${list.listDisplayName} · ${list.cards.length}`));
    const cards = document.createElement('div'); cards.className = 'overview-cards';
    if (!list.cards.length) cards.appendChild(createOverviewText('p', 'overview-empty-list', 'No cards in this list.'));
    for (const card of list.cards) cards.appendChild(renderOverviewCard(card));
    listSection.appendChild(cards); container.appendChild(listSection);
  }
  if (!project.lists.length && !project.error) container.appendChild(createOverviewText('p', 'overview-empty-list', 'This project has no lists.'));
  section.appendChild(container);
}
function renderOverviewProjects() {
  if (!isOverviewOpen()) return;
  const state = getOverviewState(), body = document.getElementById('overviewBody');
  if (!body) return;
  const projects = filterOverviewProjects(state.projects, state.query);
  const requests = state.projects.flatMap((project) => project.requests);
  document.getElementById('overviewNeedsYouTab').textContent = `Needs you${requests.length ? ` · ${requests.length}` : ''}`;
  for (const tab of ['projects', 'needs-you']) document.getElementById(tab === 'projects' ? 'overviewProjectsTab' : 'overviewNeedsYouTab')
    .setAttribute('aria-selected', String(state.tab === tab));
  document.getElementById('overviewProjectsTab').tabIndex = state.tab === 'projects' ? 0 : -1;
  document.getElementById('overviewNeedsYouTab').tabIndex = state.tab === 'needs-you' ? 0 : -1;
  const total = state.projects.reduce((sum, project) => sum + project.cardCount, 0);
  const visible = projects.reduce((sum, project) => sum + project.visibleCount, 0);
  document.getElementById('overviewCount').textContent = `${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · ${state.query.trim() ? `${visible} of ${total}` : total} cards`;
  // Keep live forms and their draft/revision untouched during background refresh.
  if (state.editing) return;
  const signature = JSON.stringify([state.query, state.tab, [...state.expanded], [...state.completed], state.projects]);
  if (signature === state.signature) return; state.signature = signature;
  const scrollTop = body.scrollTop, focused = body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
  const content = document.createDocumentFragment();
  if (!state.projects.length) content.appendChild(createOverviewText('p', 'overview-empty', 'No open projects. Open a board to see its work here.'));
  else if (!projects.length && state.tab === 'projects') content.appendChild(createOverviewText('p', 'overview-empty', 'No cards match your search.'));
  if (state.tab === 'needs-you') {
    const matching = requests.filter((card) => overviewCardMatchesQuery(card, state.query));
    for (const project of projects.filter((item) => item.error || item.briefError)) content.appendChild(createOverviewText('p', 'overview-source-warning', `${project.boardDisplayName}: Some project files could not be read. Requests may be incomplete.`));
    if (state.projects.length && !matching.length) content.appendChild(createOverviewText('p', 'overview-empty', state.query.trim() ? 'No requests match your search.' : 'Nothing needs your attention. Agents can ask a question, request a decision, or send work for review.'));
    for (const card of matching) content.appendChild(renderOverviewRequest(card));
  } else for (const project of projects) {
    const section = document.createElement('section'); section.className = 'overview-project'; section.dataset.boardRoot = project.boardRoot;
    const expanded = Boolean(state.query.trim()) || state.expanded.has(project.boardRoot);
    const header = document.createElement('div'); header.className = 'overview-project-heading';
    const toggle = overviewButton('', 'overview-project-title', () => {
      if (state.expanded.has(project.boardRoot)) state.expanded.delete(project.boardRoot); else state.expanded.add(project.boardRoot); renderOverviewProjects();
    });
    const disclosure = document.createElement('span'); disclosure.className = 'overview-disclosure';
    disclosure.setAttribute('aria-hidden', 'true');
    disclosure.innerHTML = window.feather.icons[expanded ? 'chevron-down' : 'chevron-right'].toSvg({ width: 16, height: 16 });
    toggle.append(disclosure, createOverviewText('span', '', project.boardDisplayName));
    toggle.setAttribute('aria-expanded', String(expanded)); toggle.dataset.overviewExpand = project.boardRoot; toggle.dataset.focusKey = `project:${project.boardRoot}`;
    header.appendChild(toggle); header.appendChild(createOverviewText('span', 'overview-project-count', `${project.cardCount} cards`));
    const edit = overviewButton('Edit summary', 'overview-edit-summary', () => openOverviewCoordinationEditor({ project }));
    edit.dataset.focusKey = `summary:${project.boardRoot}`; edit.setAttribute('aria-label', `Edit ${project.boardDisplayName} summary`); header.appendChild(edit); section.appendChild(header);
    section.appendChild(createOverviewText('p', 'overview-goal', project.brief.goal || 'No goal set'));
    const current = project.active.slice(0, 2).map((card) => `${card.title}${!card.hasWorkStatus ? ` (${card.listDisplayName} list)` : ''}`).join(' · ');
    const activity = document.createElement('div'); activity.className = 'overview-activity';
    activity.appendChild(createOverviewText('span', '', current ? `Working ${project.active.length} · ${current}${project.active.length > 2 ? ' …' : ''}` : 'No active work reported'));
    if (project.blocked.length) activity.appendChild(createOverviewText('span', 'overview-signal', `${project.blocked.length} blocked`));
    if (project.requests.length) { const needs = overviewButton(`${project.requests.length} needs you`, 'overview-signal', () => { state.tab = 'needs-you'; renderOverviewProjects(); }); needs.dataset.focusKey = `needs:${project.boardRoot}`; activity.appendChild(needs); }
    section.appendChild(activity);
    section.appendChild(createOverviewText('p', 'overview-next-step', `Next · ${project.brief.nextStep || 'No next step set'}`));
    if (project.error || project.briefError) { const warning = createOverviewText('p', 'overview-source-warning', `Some project files could not be read. ${project.briefError ? `Project summary: ${project.briefError}` : 'Check folder access. Overview will retry automatically.'}`); warning.setAttribute('role', 'status'); section.appendChild(warning); }
    if (expanded) renderOverviewLists(project, section); content.appendChild(section);
  }
  body.replaceChildren(content); body.scrollTop = scrollTop;
  if (focused) Array.from(body.querySelectorAll('[data-focus-key]')).find((element) => element.dataset.focusKey === focused)?.focus({ preventScroll: true });
}
async function renderOverviewView() {
  const state = getOverviewState(); if (!state.isOpen) return;
  if (state.refreshPromise) return state.refreshPromise;
  const requestId = ++state.requestId; state.lastRefreshAt = Date.now();
  state.refreshPromise = (async () => {
    const projects = await Promise.all(getStoredOpenBoards().map(readOverviewProject));
    if (!state.isOpen || requestId !== state.requestId) return;
    state.projects = projects; renderOverviewProjects();
  })().finally(() => { state.refreshPromise = null; }); return state.refreshPromise;
}
async function refreshOverviewIfDue() {
  const state = getOverviewState(); if (!state.isOpen || Date.now() - state.lastRefreshAt < 2500) return; await renderOverviewView();
}
function syncOverviewBoardTheme() {
  const overlay = document.getElementById('overviewOverlay'), planner = document.getElementById('plannerOverlay');
  if (!overlay || !planner) return;
  for (const property of Object.values(PLANNER_CARD_THEME_PROPERTIES)) {
    const value = planner.style.getPropertyValue(property); if (value) overlay.style.setProperty(property, value); else overlay.style.removeProperty(property);
  }
}
async function openOverviewView() {
  await closeAllModals({ key: 'Escape' }, { skipRerender: true });
  if (typeof closePlannerView === 'function' && isPlannerOpen()) closePlannerView({ restoreFocus: false });
  const state = getOverviewState(); state.isOpen = true; state.signature = '';
  const overlay = document.getElementById('overviewOverlay'); overlay.classList.remove('hidden'); overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('overview-open'); syncOverviewBoardTheme(); syncWorkspaceViewDockState(); await renderOverviewView();
  if (state.editing) setAccessibleModalVisible(document.getElementById('overviewCoordinationPanel'), true, { initialFocus: state.editing.focusTarget });
  else document.getElementById('overviewSearchInput').focus(); return true;
}
function closeOverviewView(options = {}) {
  const state = getOverviewState();
  if (state.editing) { state.editing.focusTarget = document.activeElement; setAccessibleModalVisible(document.getElementById('overviewCoordinationPanel'), false, { restoreFocus: false }); }
  state.isOpen = false; state.requestId += 1;
  const overlay = document.getElementById('overviewOverlay'); overlay.classList.add('hidden'); overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('overview-open'); syncWorkspaceViewDockState();
  if (options.restoreFocus !== false) document.getElementById('workspaceViewOverview').focus();
}
function initializeOverviewControls() {
  const state = getOverviewState(); if (state.initialized) return;
  const input = document.getElementById('overviewSearchInput');
  input.addEventListener('input', () => { state.query = input.value; renderOverviewProjects(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') { const first = document.querySelector('#overviewBody button'); if (first) { event.preventDefault(); first.focus(); } }
  });
  for (const [id, tab] of [['overviewProjectsTab', 'projects'], ['overviewNeedsYouTab', 'needs-you']]) {
    const button = document.getElementById(id);
    button.addEventListener('click', () => { state.tab = tab; renderOverviewProjects(); });
    button.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); state.tab = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'needs-you' : state.tab === 'projects' ? 'needs-you' : 'projects';
        renderOverviewProjects(); document.getElementById(state.tab === 'projects' ? 'overviewProjectsTab' : 'overviewNeedsYouTab').focus();
      }
    });
  }
  document.getElementById('overviewCloseButton').addEventListener('click', () => closeOverviewView()); state.initialized = true;
}
