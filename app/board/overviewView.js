// Overview preserves source workflows; coordination is explicit and optional.
function getOverviewState() {
  if (!window.__overviewState) window.__overviewState = {
    isOpen: false, initialized: false, query: '', projects: [], tab: 'now', selectedProject: '',
    completed: new Set(), requestId: 0, lastRefreshAt: 0,
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
  syncOverviewNavigation(requests.length);
  const total = state.projects.reduce((sum, project) => sum + project.cardCount, 0);
  const visible = projects.reduce((sum, project) => sum + project.visibleCount, 0);
  document.getElementById('overviewCount').textContent = `${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · ${state.query.trim() ? `${visible} of ${total}` : total} cards`;
  // An editor owns its original revision and DOM until it is closed.
  if (state.editing) return;
  const signature = JSON.stringify([state.query, state.tab, state.selectedProject, [...state.completed], state.projects, Math.floor(Date.now() / 60000)]);
  if (signature === state.signature) return;
  state.signature = signature;
  const detailBody = document.getElementById('overviewDetailBody');
  const scrollTop = body.scrollTop, detailScroll = detailBody.scrollTop;
  const focused = document.getElementById('overviewOverlay').contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
  const content = document.createDocumentFragment();
  if (!state.projects.length) content.appendChild(createOverviewText('p', 'overview-empty', 'No open projects. Open a board to see its work here.'));
  else if (state.tab === 'needs-you') renderOverviewRequestQueue(projects, requests, content);
  else {
    if (state.tab === 'now') renderOverviewNeedsPreview(requests, content);
    const heading = document.createElement('div'); heading.className = 'overview-section-heading';
    heading.append(createOverviewText('h3', '', 'Projects'), createOverviewText('span', '', `${projects.length} project${projects.length === 1 ? '' : 's'}`));
    content.appendChild(heading);
    if (!projects.length) content.appendChild(createOverviewText('p', 'overview-empty', 'No projects or cards match your search.'));
    const grid = document.createElement('div'); grid.className = 'overview-project-grid';
    for (const project of projects) grid.appendChild(renderOverviewProjectTile(project));
    content.appendChild(grid);
  }
  body.replaceChildren(content); body.scrollTop = scrollTop;
  renderOverviewProjectDetail(projects);
  detailBody.scrollTop = detailScroll;
  if (focused) Array.from(document.querySelectorAll('#overviewOverlay [data-focus-key]')).find((element) => element.dataset.focusKey === focused)?.focus({ preventScroll: true });
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
  // Now has a workspace palette. Source editors continue using their board theme.
  const overlay = document.getElementById('overviewOverlay');
  if (overlay) for (const property of Object.values(PLANNER_CARD_THEME_PROPERTIES)) overlay.style.removeProperty(property);
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
    if (event.key === 'ArrowDown' || event.key === 'Enter') { const first = state.selectedProject ? document.querySelector('#overviewDetailBody .overview-card') || document.getElementById('overviewDetailBack') : document.querySelector('#overviewBody button'); if (first) { event.preventDefault(); first.focus(); } }
  });
  const tabs = [['overviewNowTab', 'now'], ['overviewProjectsTab', 'projects'], ['overviewNeedsYouTab', 'needs-you']];
  for (const [id, tab] of tabs) {
    const button = document.getElementById(id);
    button.addEventListener('click', () => selectOverviewTab(tab));
    button.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const offset = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.findIndex((entry) => entry[1] === state.tab) + offset + tabs.length) % tabs.length;
        selectOverviewTab(tabs[index][1]); document.getElementById(tabs[index][0]).focus();
      }
    });
  }
  document.getElementById('overviewDetailBack').addEventListener('click', closeOverviewProjectDetail);
  document.getElementById('overviewOverlay').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectedProject && !state.editing && !isModalOpen('modalEditCard')) {
      event.preventDefault(); event.stopPropagation(); closeOverviewProjectDetail();
    }
  });
  for (const button of document.querySelectorAll('[data-overview-workspace]')) button.addEventListener('click', () => {
    switchWorkspaceView(button.dataset.overviewWorkspace).catch((error) => {
      console.error('Failed to switch workspace view.', error); announceSignboardStatus('Could not change workspace view.');
    });
  });
  document.getElementById('overviewCloseButton').addEventListener('click', () => closeOverviewView()); state.initialized = true;
}
